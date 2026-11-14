# Paying a share from any chain (NEAR Intents / 1Click)

ClinicPay can price a co-pay for someone who holds nothing on NEAR. 1Click (NEAR
Intents) delivers the invoice's token to the contract with the invoice message
attached, and the same `ft_on_transfer` path that handles a NEAR stablecoin payment
marks the share paid.

```
payer on Base / Solana / Bitcoin
        │  sends the quoted origin asset
        ▼
1Click solver network ──► NEAR Intents verifier ──► intents.near
                                                     │ ft_transfer_call
                                                     │ 50 Tgas floor
                                                     ▼
                                    ClinicPay.ft_on_transfer
                                      │ forwards the exact share
                                      ▼
                                    clinic (USDC on NEAR)
```

## Live dry quote (2026-11-14T19:07Z)

`node cli/clinicpay.mjs pay-from-any-chain` prices with `dry: true`; nothing moves
and no key is needed. Measured against the public 1Click API with `intents.near` as
the stand-in recipient:

| Field | Value |
| --- | --- |
| Origin | Base USDC (`nep141:base-0x8335…`) |
| Destination | NEAR USDC (`nep141:17208628…`) |
| Sent | 10.102033 Base USDC |
| Minimum sent | 10.001012 Base USDC |
| Delivered | exactly 10.000000 NEAR USDC |
| Withdraw fee | 0 |
| Estimate | 35 s |
| App fee | 1 bp |

For comparison, a card-not-present fee on a $10 co-pay is about $0.59 (2.9% + $0.30),
and CAQH's 2024 claim-payment benchmark is $3.48 manual / $1.85 electronic per
transaction. The 1Click route cost is about 0.011% at this size. That is an order of
magnitude, not a like-for-like saving: card fees buy dispute handling, and the
comparison ignores the origin chain's own network fee.

## Gas at the verifier's floor

`near/intents` withdraws via `ft_transfer_call` and can attach as little as 50 Tgas.
The sandbox stand-in test (`contract/tests/sandbox_intents.rs`) calls the token exactly
that way:

| Case | Result |
| --- | --- |
| Open share, exactly 50 Tgas | settles; clinic receives the share; contract holds 0 |
| Named-payer share | tokens returned to the sender; share stays Open |
| Duplicate delivery to a paid share | tokens returned; no double credit |
| Clinic not registered on the token, 50 Tgas | share reopens; tokens returned; contract holds 0 |
| Gas sweep | settles at 50, 45, 40, 35, 30, 25 and 20 Tgas |

So the current 15 Tgas forward + 15 Tgas callback constants already fit under the
50 Tgas floor on a `near-contract-standards` 5.30 token. **No contract gas change was
made.** The plan expected the floor to fail and a fix to be needed; it did not
reproduce, so shipping a gas change would have been risk without evidence.

## Honest limits

- **Mainnet only.** 1Click has no testnet, so this flow is proven on a local sandbox
  with a stand-in token and a live dry quote, not with real money end to end.
- **The recipient in the quote is a stand-in.** The live quote used `intents.near`
  as the recipient because ClinicPay is not deployed to mainnet. A deployed contract
  account is the only change needed for a real run.
- **Open shares only.** The contract sees `intents.near` as the sender, so a named
  payer rule would reject the delivery. Cross-chain shares must be created without a
  named payer (`"payer": null`), which the CLI checks before quoting.
- **Refunds.** If the contract rejects the delivery, the verifier credits the tokens
  back to the Intents account; the payer's origin-chain refund is 1Click's
  `refundTo` flow. ClinicPay never holds the funds.
- **Storage.** ClinicPay and the clinic must be registered on the token, or the
  forward fails and the delivery is refunded. The CLI preflights both.
- **Token support.** The invoice token must be a 1Click asset (`nep141:<token>`);
  arbitrary NEP-141 tokens are not routable.

## Sources

- 1Click API: <https://docs.near-intents.org/integration/distribution-channels/1click-api>
- `/v0/tokens` and `/v0/quote` (public, no key): `https://1click.chaindefuser.com`
- Withdraw path and 50 Tgas floor: <https://github.com/near/intents> (`withdraw.rs`)
- NEP-141 receiver flow: <https://github.com/near/NEPs/blob/master/neps/nep-0141.md>
- CAQH Index 2024: <https://caqh.org/hubfs/Index/CAQH_IndexReport_2024_FINAL.pdf>
- Stripe pricing: <https://stripe.com/pricing>
