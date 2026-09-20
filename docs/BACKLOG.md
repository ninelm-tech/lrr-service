# Product Backlog

## Preserve Location Signals for Pricing Intelligence

**Status:** Deferred

Account deletion currently clears `RescueRequest.latitude`,
`RescueRequest.longitude`, and `RescueRequest.destination`. Revisit this before
building pricing intelligence so deleting a customer account does not also
destroy the non-identity signals needed to model regional demand and pricing.

The future design should:

- define a documented retention period and access policy for exact request
  coordinates;
- create a customer-detached pricing observation when a request is completed;
- retain only the useful pricing features, such as a coarse pickup zone,
  destination zone or journey distance, issue and vehicle type, time bucket,
  accepted quote, fees, payout, quote count, response time, and outcome;
- exclude customer identifiers, contact details, media, payment references, and
  free-text statements from the pricing dataset;
- decide when exact coordinates are converted to a coarse zone and removed from
  the operational request record; and
- update the account-deletion notice and retention policy before changing the
  current deletion behavior.

Do not change latitude or longitude deletion until this retention and
de-identification design is approved.
