# services: optional daemons

Nothing here may be required for a user-facing feature. Every page works from
static files with all of this switched off; these processes only make things
faster or easier.

  indexer/    subscribes to relays, verifies listings, writes SQLite and serves
              one read-only search endpoint. The client does not need it: the
              market page queries relays directly.
  verifier/   a domain-verification daemon that publishes signed attestations
              (NIP-90 kind 6970). Anyone can run one.
  relay/      a strfry relay that stores flexmydomain events only and mirrors
              them from the public relays. The site reads the public relays
              whether it runs or not.

An endpoint the client cannot work without does not belong here. It would put
a server back at the centre of a design where the static client does every
job itself.
