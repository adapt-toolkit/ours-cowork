// Test-only permissive peer for cowork packet protocol coverage.
// It accepts files, provides notification service hooks, and can issue a real
// external-origin call to the cowork app-signing transaction.

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
        _read_or_abort = grab( _read_or_abort ).
        key_storage::init ($_read_or_abort -> _read_or_abort).
        encrypted_channel::init ($_read_or_abort -> _read_or_abort).

        fn _save_state (_) = (transaction::action::return_data ($kind -> $save_state)).
        fn _return_data (payload: any) = (transaction::action::return_data ($kind -> $data, $payload -> payload)).

        // Minimal inbound message store. It exists so a test can observe what a
        // ROOM tells this peer — in particular a room_file_rejected bounce, which
        // is the only place a sender learns its file was refused.
        metadef peer_message_t: (
            $msg_id      -> int,
            $sender_id   -> global_id,
            $sender_name -> str,
            $text        -> str,
            $status      -> str
        ).
        messages is peer_message_t[] = [].
        next_peer_msg_seq is int = 1.

        a2a_messaging::init (
            $_read_or_abort -> _read_or_abort,
            $on_message_received -> fn (arg: any) -> transaction::action::type[]
            {
                mid = next_peer_msg_seq.
                next_peer_msg_seq -> next_peer_msg_seq + 1.
                sender_name is str = "".
                if (arg $sender_name) != NIL { sender_name -> (arg $sender_name) safe str. }
                messages (_count messages|) -> (
                    $msg_id      -> mid,
                    $sender_id   -> (arg $sender_id) safe global_id,
                    $sender_name -> sender_name,
                    $text        -> (arg $text) safe str,
                    $status      -> "unread"
                ).
                return [ _save_state NIL ].
            },
            $on_message_sent -> fn (_: any) -> transaction::action::type[] { return []. },
            $on_contact_removed -> fn (_: any) -> transaction::action::type[] { return []. },
            $on_file_received -> fn (_: any) -> transaction::action::type[] { return [ _save_state NIL ]. },
            $on_file_sent -> fn (_: any) -> transaction::action::type[] { return []. },
            $on_receipt_received -> fn (_: any) -> transaction::action::type[] { return []. }
        ).

        a2a_notifications::init (
            $_read_or_abort -> _read_or_abort,
            $on_notification_posted -> fn (_: any) -> transaction::action::type[] { return [ _save_state NIL ]. },
            $on_notifications_marked_read -> fn (_: any) -> transaction::action::type[] { return [ _save_state NIL ]. },
            $on_unregistered -> fn (_: any) -> transaction::action::type[] { return [ _save_state NIL ]. },
            $on_notify_registration -> fn (_: any) -> transaction::action::type[] { return [ _save_state NIL ]. }
        ).

        a2a_capabilities::init (
            $describe -> fn (_: any) -> a2a_capabilities::app_manifest_t
            {
                return (
                    $version -> 1,
                    $app_id -> "network.ours.cowork-test-peer",
                    $name -> a2a_messaging::my_name,
                    $description -> "test-only permissive peer",
                    $monitoring_status -> "off",
                    $capabilities -> (,)
                ).
            },
            $supported -> [],
            $advertise -> [
                a2a_capabilities::cap_e2e,
                a2a_capabilities::cap_e2e_migrate,
                a2a_capabilities::cap_e2e_rekey,
                a2a_capabilities::cap_contact_removal,
                a2a_capabilities::cap_notifications
            ],
            $handlers -> (,),
            $on_unknown -> fn (_: any) -> transaction::action::type[] { return []. }
        ).
    }

    trn __init _ { return transaction::success []. }

    trn readonly list_incoming_messages _
    {
        return messages.
    }

    trn call_external_sign _:($target -> target: global_id, $canonical_json -> canonical_json: str)
    {
        current_transaction_info::validate_origin_or_abort (transaction::envelope::origin::user,).
        return encrypted_channel::execute_transaction target (fn (_) -> transaction::results::type {
            return transaction::success [
                encrypted_channel::send_encrypted_tx target (
                    $name -> "::actor::sign_app_envelope",
                    $targ -> ($canonical_json -> canonical_json)
                ),
                _return_data ($sent_to -> target)
            ].
        }).
    }

    trn accept_contact args: any { return a2a_messaging::handle_accept_contact args. }
    trn receive_message args: any { return a2a_messaging::handle_receive_message args. }
}
