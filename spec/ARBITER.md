# Arbiter policy

Anyone can be an arbiter. This document is the policy we publish for the
arbiter key we operate. Anyone can operate another arbiter and publish a
different policy. Buyers and sellers each choose which arbiters they accept,
and trade only where their two lists intersect.

If the two lists do not intersect, there is no trade, and the page says so
instead of falling back to a default arbiter.

Trading with no arbiter is also supported. Two parties who need no referee use
a two-leaf tree, and we are not in it.

## 1. What an arbiter can and cannot do

An arbiter holds one key of three. It can co-sign with the buyer or with the
seller, and it can do nothing alone: no leaf in the script tree can be spent
by the arbiter key by itself, and a test asserts this.

So an arbiter cannot take the money, cannot freeze it, and cannot prevent the
timeout path from returning it.

## 2. The SLA

These deadlines are protocol parameters. They are chosen so that the timelock
always outlasts the dispute window with room to spare.

| event | deadline |
|---|---|
| Dispute opened → acknowledged | 24 hours |
| Evidence window (both parties) | 72 hours |
| Ruling published | 72 hours after the evidence window closes |
| Total worst case | 7 days |
| Escrow timelock | 30 days |

If an arbiter misses the ruling deadline, the parties are not stuck: the
timelock still resolves the escrow without anyone's cooperation.

## 3. The only evidence that counts

In this order:

1. RDAP snapshots, ours and the parties', with their sha256 hashes
2. DNS TXT observations from the authoritative nameservers
3. The signed commitments both parties made when the escrow opened
4. Registrar correspondence, and only where it corroborates 1 to 3

Screenshots are not evidence. Emails are not evidence unless they corroborate
a snapshot. "It was working yesterday" is not evidence, but a snapshot from
yesterday is.

Every snapshot is hashed, and the hash is published in the escrow event at the
time of observation, so nobody, the arbiter included, can later claim the
registry said something it did not.

> Status: not built yet. escrow.html keeps each party's readings in that
> party's own browser and shows the latest hash; nothing publishes the hashes
> into the escrow event, and no tool signs as the arbiter. The dispute leaves
> are proven spendable on regtest, but only by the test harness. Until both
> exist, an escrow with an arbiter has a referee who cannot act.

## 4. The decision table

If a ruling requires judgement beyond this table, the table is missing a row
and should be amended in public.

| observed | ruling |
|---|---|
| RDAP shows the transfer completed to the buyer's committed fingerprint | release to seller |
| RDAP shows the fingerprint, but the buyer produces registrar correspondence that the domain is not in their account | RDAP cannot see accounts, so it cannot answer this. Decide on the registrar correspondence from both sides; a seller who cannot show the name left their account loses |
| `pendingTransfer` appeared, then the domain returned to the seller | release to buyer |
| No transfer initiated within the agreed window | release to buyer |
| Transfer completed, buyer will not co-sign | release to seller |
| Seller's domain proof vanished during a funded escrow | release to buyer |
| Domain entered `pendingDelete` or `redemptionPeriod` | release to buyer |
| Registrar reversed the transfer after completion | release to buyer |
| Both parties agree in writing | honour the agreement |
| Evidence is ambiguous | release to the buyer, and say why |

The last row favours the buyer on purpose: the buyer paid first, and an
arbiter who is unsure should not be the reason somebody loses money.

## 5. Every ruling is published

Each ruling is published as a kind 30078 event, `d = fmd:ruling:<escrow id>`,
containing the escrow id, the evidence hashes, the decision, the reasoning and
the settlement txid.

An arbiter's value lies in a permanent public record of how they have ruled,
and arbiters compete on that record. An arbiter who publishes no rulings has
no reputation to weigh, and should be chosen accordingly.

## 6. Fees

We charge nothing on a trade we did not have to arbitrate, which is nearly all
of them, because the cooperative path never involves us.

Where a dispute is opened, the fee is stated in advance in our kind 30078
`d = fmd:arbiter` record, along with our SLA and contact details. It is taken
from the escrowed amount as part of the settlement transaction, which both
parties can see before they sign.

## 7. Key hygiene

The arbiter key signs rulings and co-signs settlements. It holds no funds, it
is not the key that runs this site, and it is not the key that signs
attestations, so a compromise of any one of these keys affects only one job.

## 8. Conflicts of interest

We will not arbitrate a trade where we are the buyer, the seller or the
registrar, where we hold a listing on the same domain, or where we have a
financial relationship with either party. In any of those cases the parties
should pick a different arbiter, and the escrow should not open with ours.
