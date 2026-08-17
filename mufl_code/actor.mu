// Minimal standalone mission-room packet.
//
// Shared ours protocol, contact, invite, and encrypted-message behavior stays in
// the pinned ours-mufl-core libraries. This actor owns the room message + file
// inboxes, lifecycle, portable state wrapper, identity reseed/export, and
// app-envelope signing. It deliberately has no hierarchy, local book,
// monitoring/control, or Telegram surface.
//
// 2026-08-10 FILE POLICY HISTORY: the first room packet deliberately refused
// every inbound and outbound file because cowork had no durable relay ledger.
// The owner overturned that refusal once archive-before-consume file fan-out was
// designed. Files are now opaque bytes with filename/MIME metadata, capped so
// the pinned core can retain an unacknowledged send for crash redrive.
//
// 2026-08-17: that cap was 2 MiB exactly, which is the core's redrive budget for
// the whole SERIALIZED envelope, not for the payload — so a file at the
// documented maximum always fell outside the guarantee the maximum existed to
// protect. The accepted payload maximum is now 2,000,000 bytes (see
// max_file_bytes), and inbound refusals are reported to the sender instead of
// aborting the inbound transaction.

application actor loads libraries
    identity_proof_document,
    attestation_document,
    native_attestation_document,
    transaction_message_decoder,
    address_document,
    address_document_types,
    key_utils,
    key_storage,
    continuation,
    encrypted_channel,
    current_transaction_info,
    a2a_versions,
    a2a_capabilities,
    a2a_protocol,
    a2a_messaging,
    a2a_notifications,
    protocol_container,
    registration_proof,
    version
    uses transactions
{
    hidden
    {
        metadef message_t: (
            $msg_id      -> int,
            $sender_id   -> global_id,
            $sender_name -> str,
            $text        -> str,
            $date        -> time,
            $status      -> str,
            $wire_id     -> str,
            $reply_to    -> a2a_protocol::reply_ref_t+
        ).
        // $reject_reason/$reject_bytes are NIL on an accepted file. They are set
        // when the room refused the file: the record is then deposited with an
        // EMPTY $data (the refused payload is never made durable) so the host can
        // tell the sender what happened. Both are nullable, so state exported by
        // an actor that predates them still imports.
        metadef file_t: (
            $file_id       -> int,
            $sender_id     -> global_id,
            $sender_name   -> str,
            $filename      -> str,
            $mime          -> str,
            $data          -> bin,
            $date          -> time,
            $status        -> str,
            $wire_id       -> str,
            $reply_to      -> a2a_protocol::reply_ref_t+,
            $reject_reason -> str+,
            $reject_bytes  -> int+
        ).
        // The ACCEPTED payload maximum. Deliberately below the pinned core's
        // unacked_file_entry_max_bytes (2097152), which it measures against the
        // SERIALIZED envelope — filename, mime, data, wire_id, reply_to, pv — not
        // the payload. A payload at 2097152 therefore always exceeded the core's
        // redrive budget and was silently not retained for automatic resend. At
        // 2000000 every accepted file clears that budget with room to spare for
        // metadata (up to 510 bytes of filename + MIME) and fixed framing, so
        // "accepted" now really does mean "retained for redrive on every leg".
        max_file_bytes is int = 2000000.
        max_file_name_bytes is int = 255.
        max_file_mime_bytes is int = 255.

        _read_or_abort = grab( _read_or_abort ).
        key_storage::init ($_read_or_abort -> _read_or_abort).
        encrypted_channel::init ($_read_or_abort -> _read_or_abort).

        inbox is message_t[] = [].
        next_msg_seq is int = 1.
        files is file_t[] = [].
        next_file_seq is int = 1.

        fn _save_state (_) = (transaction::action::return_data ($kind -> $save_state)).
        fn _return_data (payload: any) = (transaction::action::return_data ($kind -> $data, $payload -> payload)).
        fn _notify_agent (payload: any) = (transaction::action::return_data ($kind -> $notify_agent, $payload -> payload)).

        fn deposit_message (
            sender_id: global_id,
            sender_name: str,
            text: str,
            msg_date: time,
            wire_id: str,
            reply_to: a2a_protocol::reply_ref_t+
        ) -> int
        {
            mid = next_msg_seq.
            next_msg_seq -> next_msg_seq + 1.
            inbox (_count inbox|) -> (
                $msg_id      -> mid,
                $sender_id   -> sender_id,
                $sender_name -> sender_name,
                $text        -> text,
                $date        -> msg_date,
                $status      -> "unread",
                $wire_id     -> wire_id,
                $reply_to    -> reply_to
            ).
            return mid.
        }

        // A refused inbound file deposits an EMPTY payload with a reason. The
        // refused bytes are never written into durable packet state; only the
        // metadata the host needs to tell the sender what was refused is kept.
        fn deposit_file (
            sender_id: global_id,
            sender_name: str,
            filename: str,
            mime: str,
            data: bin,
            file_date: time,
            wire_id: str,
            reply_to: a2a_protocol::reply_ref_t+,
            reject_reason: str
        ) -> int
        {
            fid = next_file_seq.
            next_file_seq -> next_file_seq + 1.
            kept is bin = data.
            kept_name is str = filename.
            kept_mime is str = mime.
            reason is str+ = NIL.
            reject_bytes is int+ = NIL.
            if reject_reason != ""
            {
                kept -> _hex_string_to_binary "".
                reason -> reject_reason.
                reject_bytes -> _binlen data.
                // A refused file is the one path where unvalidated metadata
                // reaches durable state. Keep it only while it is inside the
                // bound it failed some OTHER check against; an over-long name or
                // MIME is dropped rather than persisted at the sender's chosen
                // length.
                if (_strlen filename) > max_file_name_bytes { kept_name -> "". }
                if (_strlen mime) > max_file_mime_bytes { kept_mime -> "". }
            }
            files (_count files|) -> (
                $file_id       -> fid,
                $sender_id     -> sender_id,
                $sender_name   -> sender_name,
                $filename      -> kept_name,
                $mime          -> kept_mime,
                $data          -> kept,
                $date          -> file_date,
                $status        -> "unread",
                $wire_id       -> wire_id,
                $reply_to      -> reply_to,
                $reject_reason -> reason,
                $reject_bytes  -> reject_bytes
            ).
            return fid.
        }

        // Keep this boundary identical to FileNameSchema/FileMimeSchema and
        // MAX_FILE_BYTES in src/contracts.ts.
        //
        // 2026-08-17: this used to `abort`, which rolled back the whole inbound
        // transaction. That destroyed the sender correlation the actor was
        // holding ($sender_id) and took the delivered receipt with it, so a
        // refused file looked like SUCCESS to its sender and left no trace in
        // room history — the host journal was the only place the refusal
        // existed. It now returns a reason instead, and the transaction commits
        // with an empty-payload rejection record that the host bounces to the
        // sender and appends to the archive. Returns "" when the file is
        // acceptable.
        fn file_reject_reason (filename: str, mime: str, data: bin) -> str
        {
            if (_strlen filename) < 1 { return "invalid_filename". }
            if (_strlen filename) > max_file_name_bytes { return "invalid_filename". }
            if filename == "." || filename == ".." { return "invalid_filename". }
            path_character is bool = FALSE.
            sc filename -- ( -> character)
            {
                if character == "/" || character == "\\" || character == "\0" { path_character -> TRUE. }
            }
            if path_character { return "invalid_filename". }
            if (_strlen mime) > max_file_mime_bytes { return "invalid_mime". }
            if (_binlen data) > max_file_bytes { return "too_large". }
            return "".
        }

        a2a_messaging::init (
            $_read_or_abort -> _read_or_abort,
            $on_message_received -> fn (arg: any) -> transaction::action::type[]
            {
                abort "Message from an unknown sender was rejected." when (arg $sender_name) == NIL.
                sender_id = (arg $sender_id) safe global_id.
                sender_name = (arg $sender_name) safe str.
                text = (arg $text) safe str.
                msg_date = (arg $date) safe time.
                wire_id is str = "".
                if (arg $wire_id) != NIL { wire_id -> (arg $wire_id) safe str. }
                reply_to is a2a_protocol::reply_ref_t+ = NIL.
                if (arg $reply_to) != NIL { reply_to -> (arg $reply_to) safe a2a_protocol::reply_ref_t. }
                mid = deposit_message sender_id sender_name text msg_date wire_id reply_to.
                return [
                    _notify_agent ($event -> $message_received, $sender_name -> sender_name, $msg_id -> mid, $date -> msg_date),
                    _save_state NIL
                ].
            },
            $on_message_sent -> fn (_: any) -> transaction::action::type[] { return []. },
            $on_contact_removed -> fn (_: any) -> transaction::action::type[] { return []. },
            // 2026-08-10: positive successor to the deliberate blanket refusal
            // above.
            //
            // 2026-08-17: an unknown sender still fails closed — there is no
            // contact to answer, so there is nothing an abort can destroy. An
            // over-limit or badly-named file does NOT abort any more. Aborting
            // rolled back the delivered receipt along with the deposit, so the
            // sender got SUCCESS for a file the room had refused and nobody
            // received; the only record was a host-journal line. The refusal is
            // now committed as an empty-payload record which the host bounces to
            // the sender and appends to room history.
            $on_file_received -> fn (arg: any) -> transaction::action::type[]
            {
                abort "File from an unknown sender was rejected." when (arg $sender_name) == NIL.
                sender_id = (arg $sender_id) safe global_id.
                sender_name = (arg $sender_name) safe str.
                filename = (arg $filename) safe str.
                mime is str = "".
                if (arg $mime) != NIL { mime -> (arg $mime) safe str. }
                data = (arg $data) safe bin.
                file_date = (arg $date) safe time.
                wire_id is str = "".
                if (arg $wire_id) != NIL { wire_id -> (arg $wire_id) safe str. }
                reply_to is a2a_protocol::reply_ref_t+ = NIL.
                if (arg $reply_to) != NIL { reply_to -> (arg $reply_to) safe a2a_protocol::reply_ref_t. }
                reject_reason = file_reject_reason filename mime data.
                fid = deposit_file sender_id sender_name filename mime data file_date wire_id reply_to reject_reason.
                return [
                    _notify_agent ($event -> $file_received, $sender_name -> sender_name, $file_id -> fid, $wire_id -> wire_id, $filename -> filename, $mime -> mime, $bytes -> _binlen data, $date -> file_date, $rejected -> reject_reason),
                    _save_state NIL
                ].
            },
            $on_file_sent -> fn (arg: any) -> transaction::action::type[]
            {
                data = (arg $data) safe bin.
                abort "Room files must be at most 2000000 bytes." when (_binlen data) > max_file_bytes.
                return [].
            },
            $on_receipt_received -> fn (_: any) -> transaction::action::type[] { return []. }
        ).

        // Cowork is a notification CLIENT only. The shared library owns its
        // registration/token state; successful confirmations persist that state.
        // Service-side notification delivery is deliberately unsupported because
        // room packets have no notification log or WebPush host.
        a2a_notifications::init (
            $_read_or_abort -> _read_or_abort,
            $on_notification_posted -> fn (_: any) -> transaction::action::type[]
            {
                abort "Room packets do not provide notification service" when TRUE.
                return [].
            },
            $on_notifications_marked_read -> fn (_: any) -> transaction::action::type[]
            {
                return [ _save_state NIL ].
            },
            $on_unregistered -> fn (arg: any) -> transaction::action::type[]
            {
                return [
                    _notify_agent ($event -> $notification_unregistered, $recipient_cid -> arg $recipient_cid),
                    _save_state NIL
                ].
            },
            $on_notify_registration -> fn (arg: any) -> transaction::action::type[]
            {
                return [
                    _notify_agent ($event -> $notification_registered, $service_cid -> arg $service_cid),
                    _save_state NIL
                ].
            }
        ).

        // The packet implements no app capability verbs. It advertises the core
        // protocol surfaces its pinned messaging engine actually speaks.
        a2a_capabilities::init (
            $describe -> fn (_: any) -> a2a_capabilities::app_manifest_t
            {
                return (
                    $version -> 1,
                    $app_id -> "network.ours.cowork-room",
                    $name -> a2a_messaging::my_name,
                    $description -> a2a_messaging::my_bio,
                    $monitoring_status -> "off",
                    $capabilities -> (,)
                ).
            },
            $supported -> [],
            $advertise -> [
                a2a_capabilities::cap_e2e,
                a2a_capabilities::cap_e2e_migrate,
                a2a_capabilities::cap_e2e_rekey,
                a2a_capabilities::cap_contact_removal
            ],
            $handlers -> (,),
            $on_unknown -> fn (_: any) -> transaction::action::type[] { return []. }
        ).
    }

    trn __init arg
    {
        if _typeof arg == "STRING"
        {
            key_storage::reseed_identity_from_secret
                ((_read_or_abort (_hex_string_to_binary (arg SAFE(str)))) SAFE(secretkey_sign)).
        }
        return transaction::success [].
    }

    trn readonly list_incoming_messages _
    {
        return inbox.
    }

    trn get_messages _
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        fresh is message_t[] = [].
        updated is message_t[] = [].
        sc inbox -- ( -> message)
        {
            if (message $status) == "unread"
            {
                fresh (_count fresh|) -> message.
                updated (_count updated|) -> (
                    $msg_id      -> message $msg_id,
                    $sender_id   -> message $sender_id,
                    $sender_name -> message $sender_name,
                    $text        -> message $text,
                    $date        -> message $date,
                    $status      -> "processed",
                    $wire_id     -> message $wire_id,
                    $reply_to    -> message $reply_to
                ).
            }
            else { updated (_count updated|) -> message. }
        }
        inbox -> updated.
        return transaction::success [
            _return_data ($messages -> fresh),
            _save_state NIL
        ].
    }

    trn readonly list_incoming_files _
    {
        return files.
    }

    // Receiver-side byte egress used by ordinary clients/tests. The cowork host
    // itself uses the stricter readonly-snapshot + consume_files pair so it can
    // fsync archive bytes and every relay intent before changing packet state.
    trn get_files _
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        fresh is file_t[] = [].
        updated is file_t[] = [].
        sc files -- ( -> f)
        {
            if (f $status) == "unread"
            {
                processed is file_t = (
                    $file_id -> f $file_id, $sender_id -> f $sender_id,
                    $sender_name -> f $sender_name, $filename -> f $filename,
                    $mime -> f $mime, $data -> f $data, $date -> f $date,
                    $status -> "processed", $wire_id -> f $wire_id,
                    $reply_to -> f $reply_to,
                    $reject_reason -> f $reject_reason, $reject_bytes -> f $reject_bytes
                ).
                fresh (_count fresh|) -> processed.
                updated (_count updated|) -> processed.
            }
            else { updated (_count updated|) -> f. }
        }
        files -> updated.
        return transaction::success [
            _return_data ($files -> fresh),
            _save_state NIL
        ].
    }

    // Atomically consume only the unread file IDs admitted by a host snapshot.
    // The bytes are already in the fsynced cowork archive before this runs.
    trn consume_files _:($expected_ids -> ids: int[])
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        wanted is (int ->> bool) = (,).
        sc ids -- ( -> id) { wanted id -> TRUE. }
        consumed is int[] = [].
        deferred is int[] = [].
        updated is file_t[] = [].
        sc files -- ( -> f)
        {
            if (f $status) == "unread"
            {
                fid = f $file_id.
                if wanted fid
                {
                    consumed (_count consumed|) -> fid.
                    updated (_count updated|) -> (
                        $file_id -> f $file_id, $sender_id -> f $sender_id,
                        $sender_name -> f $sender_name, $filename -> f $filename,
                        $mime -> f $mime, $data -> f $data, $date -> f $date,
                        $status -> "processed", $wire_id -> f $wire_id,
                        $reply_to -> f $reply_to,
                        $reject_reason -> f $reject_reason, $reject_bytes -> f $reject_bytes
                    ).
                }
                else
                {
                    deferred (_count deferred|) -> fid.
                    updated (_count updated|) -> f.
                }
            }
            else { updated (_count updated|) -> f. }
        }
        files -> updated.
        return transaction::success [
            _return_data ($consumed -> consumed, $deferred -> deferred),
            _save_state NIL
        ].
    }

    // Atomically consume only the unread IDs admitted by a host snapshot.
    // Unexpected arrivals remain unread throughout this one transaction; no
    // second defer transaction or crash window exists.
    trn consume_messages _:($expected_ids -> ids: int[])
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        wanted is (int ->> bool) = (,).
        sc ids -- ( -> id) { wanted id -> TRUE. }
        consumed is int[] = [].
        deferred is int[] = [].
        updated is message_t[] = [].
        sc inbox -- ( -> message)
        {
            if (message $status) == "unread"
            {
                mid = message $msg_id.
                if wanted mid
                {
                    consumed (_count consumed|) -> mid.
                    updated (_count updated|) -> (
                        $msg_id      -> message $msg_id,
                        $sender_id   -> message $sender_id,
                        $sender_name -> message $sender_name,
                        $text        -> message $text,
                        $date        -> message $date,
                        $status      -> "processed",
                        $wire_id     -> message $wire_id,
                        $reply_to    -> message $reply_to
                    ).
                }
                else
                {
                    deferred (_count deferred|) -> mid.
                    updated (_count updated|) -> message.
                }
            }
            else { updated (_count updated|) -> message. }
        }
        inbox -> updated.
        return transaction::success [
            _return_data ($consumed -> consumed, $deferred -> deferred),
            _save_state NIL
        ].
    }

    trn defer_messages _:($msg_ids -> ids: int[])
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        wanted is (int ->> bool) = (,).
        sc ids -- ( -> id) { wanted id -> TRUE. }
        updated is message_t[] = [].
        deferred is int = 0.
        sc inbox -- ( -> message)
        {
            if (wanted (message $msg_id)) && (((message $status) == "processed") || ((message $status) == "ready_to_delete"))
            {
                updated (_count updated|) -> (
                    $msg_id      -> message $msg_id,
                    $sender_id   -> message $sender_id,
                    $sender_name -> message $sender_name,
                    $text        -> message $text,
                    $date        -> message $date,
                    $status      -> "unread",
                    $wire_id     -> message $wire_id,
                    $reply_to    -> message $reply_to
                ).
                deferred -> deferred + 1.
            }
            else { updated (_count updated|) -> message. }
        }
        inbox -> updated.
        return transaction::success [
            _return_data ($deferred -> deferred),
            _save_state NIL
        ].
    }

    trn gc _
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        kept is message_t[] = [].
        deleted is int = 0.
        promoted is int = 0.
        sc inbox -- ( -> message)
        {
            if (message $status) == "ready_to_delete"
            {
                deleted -> deleted + 1.
            }
            elif (message $status) == "processed"
            {
                kept (_count kept|) -> (
                    $msg_id      -> message $msg_id,
                    $sender_id   -> message $sender_id,
                    $sender_name -> message $sender_name,
                    $text        -> message $text,
                    $date        -> message $date,
                    $status      -> "ready_to_delete",
                    $wire_id     -> message $wire_id,
                    $reply_to    -> message $reply_to
                ).
                promoted -> promoted + 1.
            }
            else { kept (_count kept|) -> message. }
        }
        inbox -> kept.
        kept_files is file_t[] = [].
        sc files -- ( -> f)
        {
            if (f $status) == "ready_to_delete"
            {
                deleted -> deleted + 1.
            }
            elif (f $status) == "processed"
            {
                kept_files (_count kept_files|) -> (
                    $file_id -> f $file_id, $sender_id -> f $sender_id,
                    $sender_name -> f $sender_name, $filename -> f $filename,
                    $mime -> f $mime, $data -> f $data, $date -> f $date,
                    $status -> "ready_to_delete", $wire_id -> f $wire_id,
                    $reply_to -> f $reply_to,
                    $reject_reason -> f $reject_reason, $reject_bytes -> f $reject_bytes
                ).
                promoted -> promoted + 1.
            }
            else { kept_files (_count kept_files|) -> f. }
        }
        files -> kept_files.
        return transaction::success [
            _return_data ($deleted -> deleted, $promoted -> promoted),
            _save_state NIL
        ].
    }

    trn readonly export_state _
    {
        return (
            $app_format_version -> 1,
            $core -> a2a_messaging::export_core_state NIL,
            $notifications -> a2a_notifications::export_notify_state NIL,
            $inbox -> inbox,
            $next_msg_seq -> next_msg_seq,
            $files -> files,
            $next_file_seq -> next_file_seq
        ).
    }

    trn import_state data: any
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        app_format is int = 0.
        if (data $app_format_version) != NIL { app_format -> (data $app_format_version) safe int. }
        abort "Cowork state blob is newer than this packet." when app_format > 1.
        a2a_messaging::import_core_state (data $core).
        if (data $notifications) != NIL
        {
            a2a_notifications::import_notify_state (data $notifications).
        }
        inbox -> (data $inbox) safe (message_t[]).
        next_msg_seq -> (data $next_msg_seq) safe int.
        if (data $files) != NIL { files -> (data $files) safe (file_t[]). }
        if (data $next_file_seq) != NIL { next_file_seq -> (data $next_file_seq) safe int. }
        return transaction::success [
            _return_data ($imported -> TRUE),
            _save_state NIL
        ].
    }

    trn readonly export_signing_secret _
    {
        return key_storage::export_identity_signing_secret().
    }

    trn sign_app_envelope _:($canonical_json -> canonical_json: str)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        return transaction::success [
            _return_data ($signature -> (_write (key_storage::default_sign (_value_id canonical_json))))
        ].
    }

    // Network compatibility shims retained by the shared messaging protocol.
    trn accept_contact args: any
    {
        return a2a_messaging::handle_accept_contact args.
    }

    trn receive_message args: any
    {
        return a2a_messaging::handle_receive_message args.
    }
}
