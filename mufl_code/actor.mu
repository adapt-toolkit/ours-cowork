// Minimal standalone mission-room packet.
//
// Shared ours protocol, contact, invite, and encrypted-message behavior stays in
// the pinned ours-mufl-core libraries. This actor owns only the room inbox, its
// lifecycle, portable state wrapper, identity reseed/export, and app-envelope
// signing. It deliberately has no hierarchy, local book, monitoring/control,
// Telegram, or file storage.

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

        _read_or_abort = grab( _read_or_abort ).
        key_storage::init ($_read_or_abort -> _read_or_abort).
        encrypted_channel::init ($_read_or_abort -> _read_or_abort).

        inbox is message_t[] = [].
        next_msg_seq is int = 1.

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
            $on_file_received -> fn (_: any) -> transaction::action::type[]
            {
                abort "Room packets do not accept files" when TRUE.
                return [].
            },
            $on_file_sent -> fn (_: any) -> transaction::action::type[]
            {
                abort "Room packets do not accept files" when TRUE.
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
            $next_msg_seq -> next_msg_seq
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
