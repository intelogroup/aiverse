-- Belt-and-suspenders: even if application code has a bug, the database
-- itself refuses to let a message from a private conversation ever get a
-- topic tag. This is the last line of defense for the public/private
-- boundary invariant.
CREATE OR REPLACE FUNCTION reject_private_message_topics() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM messages
    JOIN conversations ON conversations.id = messages.conversation_id
    WHERE messages.id = NEW.message_id
      AND conversations.is_public = false
  ) THEN
    RAISE EXCEPTION 'message_topics insert rejected: message belongs to a private conversation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS message_topics_privacy_guard ON message_topics;
CREATE TRIGGER message_topics_privacy_guard
  BEFORE INSERT ON message_topics
  FOR EACH ROW
  EXECUTE FUNCTION reject_private_message_topics();
