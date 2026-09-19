-- Dispatch progression now lives on RescueRequest (dispatchRound,
-- offeredOperatorIds), added in the durable_scheduling migration. Leaving
-- these behind would keep a second, stale copy of the same state on a
-- per-person row — the ambiguity this move exists to remove.
--
-- Dropping is safe: RescueRequest is the only reader as of this commit, and
-- there are no live requests.
ALTER TABLE "WhatsAppSession" DROP COLUMN "dispatchRound";
ALTER TABLE "WhatsAppSession" DROP COLUMN "offeredOperatorIds";
