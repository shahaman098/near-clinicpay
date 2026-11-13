//! ClinicPay: split-payer clinic invoices with on-chain receipts.
//!
//! A clinic (the `payee`) creates an invoice made of line items and one or more
//! *shares*. Each share is a slice of the bill owed by one party: the patient's
//! co-pay, the insurer's portion, an employer scheme. Every share is paid
//! separately, from any account, and each payment is forwarded straight to the
//! clinic and written to chain as a receipt (NEP-297 event). The invoice is
//! `Paid` once every share is paid. A paid share can be refunded by the clinic,
//! and the money goes back to whoever paid it.
//!
//! Amounts are yoctoNEAR. This contract never holds funds: a payment is
//! forwarded in the same call, and if the forward fails the state is rolled back
//! and the payer is refunded.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::IterableMap;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

const MAX_LINES: usize = 50;
const MAX_SHARES: usize = 10;
const MAX_TEXT: usize = 200;
const MAX_ID: usize = 64;
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub description: String,
    pub amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ShareState {
    Open,
    Paid,
    Refunded,
}

/// What the clinic asks for when it creates a share.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ShareInput {
    /// Human label, e.g. "Patient co-pay" or "Insurer (Bupa)".
    pub label: String,
    /// If set, only this account may pay the share. If unset, anyone may.
    pub payer: Option<AccountId>,
    pub amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Share {
    pub label: String,
    pub payer: Option<AccountId>,
    pub amount: U128,
    pub state: ShareState,
    pub paid_by: Option<AccountId>,
    pub paid_at_ms: Option<U64>,
    pub refunded_at_ms: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Invoice {
    pub id: String,
    pub payee: AccountId,
    pub memo: String,
    pub lines: Vec<Line>,
    pub shares: Vec<Share>,
    pub due_ms: Option<U64>,
    pub created_ms: U64,
    pub cancelled: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Open,
    PartiallyPaid,
    Paid,
    Refunded,
    Overdue,
    Cancelled,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ClinicPay {
    invoices: IterableMap<String, Invoice>,
}

#[near]
impl ClinicPay {
    #[init]
    pub fn new() -> Self {
        Self {
            invoices: IterableMap::new(b"i"),
        }
    }

    /// Create an invoice. The caller becomes the payee and receives every payment.
    /// The sum of the shares must equal the sum of the lines.
    pub fn create_invoice(
        &mut self,
        id: String,
        memo: String,
        lines: Vec<Line>,
        shares: Vec<ShareInput>,
        due_ms: Option<U64>,
    ) -> Invoice {
        require!(!id.is_empty() && id.len() <= MAX_ID, "id must be 1-64 characters");
        require!(memo.len() <= MAX_TEXT, "memo too long");
        require!(!lines.is_empty() && lines.len() <= MAX_LINES, "1-50 lines required");
        require!(!shares.is_empty() && shares.len() <= MAX_SHARES, "1-10 shares required");
        require!(!self.invoices.contains_key(&id), "invoice id already exists");

        let mut total: u128 = 0;
        for l in &lines {
            require!(l.description.len() <= MAX_TEXT, "line description too long");
            require!(l.amount.0 > 0, "line amounts must be positive");
            total = total.checked_add(l.amount.0).expect("amount overflow");
        }
        let mut share_total: u128 = 0;
        for s in &shares {
            require!(s.label.len() <= MAX_TEXT, "share label too long");
            require!(s.amount.0 > 0, "share amounts must be positive");
            share_total = share_total.checked_add(s.amount.0).expect("amount overflow");
        }
        require!(share_total == total, "shares must add up to the lines total");

        let payee = env::predecessor_account_id();
        let invoice = Invoice {
            id: id.clone(),
            payee: payee.clone(),
            memo,
            lines,
            shares: shares
                .into_iter()
                .map(|s| Share {
                    label: s.label,
                    payer: s.payer,
                    amount: s.amount,
                    state: ShareState::Open,
                    paid_by: None,
                    paid_at_ms: None,
                    refunded_at_ms: None,
                })
                .collect(),
            due_ms,
            created_ms: now_ms(),
            cancelled: false,
        };
        self.invoices.insert(id.clone(), invoice.clone());
        emit(
            "invoice_created",
            &format!(
                r#"{{"id":"{}","payee":"{}","total":"{}"}}"#,
                esc(&id),
                payee,
                total
            ),
        );
        invoice
    }

    /// Pay one share. Attach exactly the share amount. The money is forwarded to
    /// the clinic in the same call and a receipt event is logged.
    #[payable]
    pub fn pay_share(&mut self, invoice_id: String, share_index: u32) -> Promise {
        let deposit = env::attached_deposit();
        let payer = env::predecessor_account_id();
        let invoice = self.invoices.get_mut(&invoice_id).expect("no such invoice");
        require!(!invoice.cancelled, "invoice is cancelled");
        let payee = invoice.payee.clone();
        let share = invoice
            .shares
            .get_mut(share_index as usize)
            .expect("no such share");
        require!(share.state == ShareState::Open, "share is not open");
        if let Some(only) = &share.payer {
            require!(only == &payer, "this share must be paid by its named payer");
        }
        require!(
            deposit.as_yoctonear() == share.amount.0,
            "attach exactly the share amount"
        );

        share.state = ShareState::Paid;
        share.paid_by = Some(payer.clone());
        share.paid_at_ms = Some(now_ms());
        let amount = share.amount.0;

        emit(
            "share_paid",
            &format!(
                r#"{{"id":"{}","share":{},"payer":"{}","payee":"{}","amount":"{}"}}"#,
                esc(&invoice_id),
                share_index,
                payer,
                payee,
                amount
            ),
        );

        Promise::new(payee)
            .transfer(deposit)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_payout(invoice_id, share_index, payer, U128(amount)),
            )
    }

    /// Clinic refunds a paid share. Attach exactly the share amount; it goes back
    /// to the account that paid.
    #[payable]
    pub fn refund_share(&mut self, invoice_id: String, share_index: u32) -> Promise {
        let deposit = env::attached_deposit();
        let caller = env::predecessor_account_id();
        let invoice = self.invoices.get_mut(&invoice_id).expect("no such invoice");
        require!(caller == invoice.payee, "only the clinic can refund");
        let share = invoice
            .shares
            .get_mut(share_index as usize)
            .expect("no such share");
        require!(share.state == ShareState::Paid, "share is not paid");
        require!(
            deposit.as_yoctonear() == share.amount.0,
            "attach exactly the share amount"
        );
        let to = share.paid_by.clone().expect("paid share has a payer");
        share.state = ShareState::Refunded;
        share.refunded_at_ms = Some(now_ms());
        let amount = share.amount.0;

        emit(
            "share_refunded",
            &format!(
                r#"{{"id":"{}","share":{},"to":"{}","amount":"{}"}}"#,
                esc(&invoice_id),
                share_index,
                to,
                amount
            ),
        );

        Promise::new(to).transfer(deposit).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_refund(invoice_id, share_index, caller, U128(amount)),
        )
    }

    /// Clinic cancels an invoice that has no payments on it.
    pub fn cancel_invoice(&mut self, invoice_id: String) {
        let caller = env::predecessor_account_id();
        let invoice = self.invoices.get_mut(&invoice_id).expect("no such invoice");
        require!(caller == invoice.payee, "only the clinic can cancel");
        require!(!invoice.cancelled, "already cancelled");
        require!(
            invoice.shares.iter().all(|s| s.state == ShareState::Open),
            "cannot cancel an invoice with payments; refund them first"
        );
        invoice.cancelled = true;
        emit("invoice_cancelled", &format!(r#"{{"id":"{}"}}"#, esc(&invoice_id)));
    }

    // ---- views -----------------------------------------------------------

    pub fn get_invoice(&self, invoice_id: String) -> Option<Invoice> {
        self.invoices.get(&invoice_id).cloned()
    }

    pub fn get_status(&self, invoice_id: String) -> Option<Status> {
        self.invoices
            .get(&invoice_id)
            .map(|i| status_of(i, env::block_timestamp_ms()))
    }

    /// Invoices of one clinic, oldest first. `limit` is capped at 50.
    pub fn list_invoices(
        &self,
        payee: AccountId,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<Invoice> {
        let limit = limit.unwrap_or(25).min(50) as usize;
        self.invoices
            .values()
            .filter(|i| i.payee == payee)
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit)
            .cloned()
            .collect()
    }

    // ---- callbacks -------------------------------------------------------

    /// If forwarding a payment to the clinic failed, undo the payment and refund
    /// the payer, so a bad payee account can never trap money here.
    #[private]
    pub fn on_payout(
        &mut self,
        invoice_id: String,
        share_index: u32,
        payer: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_ok() {
            return;
        }
        if let Some(invoice) = self.invoices.get_mut(&invoice_id) {
            if let Some(share) = invoice.shares.get_mut(share_index as usize) {
                share.state = ShareState::Open;
                share.paid_by = None;
                share.paid_at_ms = None;
            }
        }
        emit(
            "payment_reverted",
            &format!(
                r#"{{"id":"{}","share":{},"payer":"{}","amount":"{}"}}"#,
                esc(&invoice_id),
                share_index,
                payer,
                amount.0
            ),
        );
        let _ = Promise::new(payer).transfer(NearToken::from_yoctonear(amount.0));
    }

    /// If a refund could not be delivered, restore the share to Paid and return
    /// the clinic's deposit.
    #[private]
    pub fn on_refund(
        &mut self,
        invoice_id: String,
        share_index: u32,
        clinic: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_ok() {
            return;
        }
        if let Some(invoice) = self.invoices.get_mut(&invoice_id) {
            if let Some(share) = invoice.shares.get_mut(share_index as usize) {
                share.state = ShareState::Paid;
                share.refunded_at_ms = None;
            }
        }
        emit(
            "refund_reverted",
            &format!(
                r#"{{"id":"{}","share":{},"amount":"{}"}}"#,
                esc(&invoice_id),
                share_index,
                amount.0
            ),
        );
        let _ = Promise::new(clinic).transfer(NearToken::from_yoctonear(amount.0));
    }
}

fn status_of(i: &Invoice, now: u64) -> Status {
    if i.cancelled {
        return Status::Cancelled;
    }
    let open = i.shares.iter().filter(|s| s.state == ShareState::Open).count();
    let paid = i.shares.iter().filter(|s| s.state == ShareState::Paid).count();
    let refunded = i.shares.iter().filter(|s| s.state == ShareState::Refunded).count();
    if refunded == i.shares.len() {
        return Status::Refunded;
    }
    if open == 0 && paid + refunded == i.shares.len() {
        return Status::Paid;
    }
    let overdue = i.due_ms.map(|d| now > d.0).unwrap_or(false);
    if overdue {
        return Status::Overdue;
    }
    if paid > 0 {
        Status::PartiallyPaid
    } else {
        Status::Open
    }
}

fn now_ms() -> U64 {
    U64(env::block_timestamp_ms())
}

/// Escape the two characters that can break the hand-built JSON in event logs.
fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// NEP-297 event log.
fn emit(event: &str, data: &str) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"clinicpay","version":"1.0.0","event":"{}","data":[{}]}}"#,
        event, data
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    fn ctx(who: AccountId, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who.clone())
            .signer_account_id(who)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(1_000_000_000_000)
            .build());
    }

    fn lines() -> Vec<Line> {
        vec![
            Line { description: "Consultation".into(), amount: U128(2 * NEAR) },
            Line { description: "Blood panel".into(), amount: U128(3 * NEAR) },
        ]
    }

    fn two_shares() -> Vec<ShareInput> {
        vec![
            ShareInput { label: "Patient co-pay".into(), payer: Some(accounts(2)), amount: U128(NEAR) },
            ShareInput { label: "Insurer".into(), payer: Some(accounts(3)), amount: U128(4 * NEAR) },
        ]
    }

    fn setup() -> ClinicPay {
        ctx(accounts(1), 0);
        let mut c = ClinicPay::new();
        c.create_invoice("INV-1".into(), "Visit 12 Nov".into(), lines(), two_shares(), None);
        c
    }

    #[test]
    fn creates_invoice_and_reports_open() {
        let c = setup();
        let inv = c.get_invoice("INV-1".into()).unwrap();
        assert_eq!(inv.payee, accounts(1));
        assert_eq!(inv.shares.len(), 2);
        assert_eq!(c.get_status("INV-1".into()), Some(Status::Open));
    }

    #[test]
    #[should_panic(expected = "shares must add up to the lines total")]
    fn rejects_shares_that_do_not_match_lines() {
        ctx(accounts(1), 0);
        let mut c = ClinicPay::new();
        let bad = vec![ShareInput { label: "x".into(), payer: None, amount: U128(NEAR) }];
        c.create_invoice("INV-2".into(), "".into(), lines(), bad, None);
    }

    #[test]
    #[should_panic(expected = "invoice id already exists")]
    fn rejects_duplicate_id() {
        let mut c = setup();
        ctx(accounts(1), 0);
        c.create_invoice("INV-1".into(), "".into(), lines(), two_shares(), None);
    }

    #[test]
    fn partial_then_full_payment_marks_paid() {
        let mut c = setup();
        ctx(accounts(2), NEAR);
        let _ = c.pay_share("INV-1".into(), 0);
        assert_eq!(c.get_status("INV-1".into()), Some(Status::PartiallyPaid));
        ctx(accounts(3), 4 * NEAR);
        let _ = c.pay_share("INV-1".into(), 1);
        assert_eq!(c.get_status("INV-1".into()), Some(Status::Paid));
        let inv = c.get_invoice("INV-1".into()).unwrap();
        assert_eq!(inv.shares[1].paid_by, Some(accounts(3)));
    }

    #[test]
    #[should_panic(expected = "named payer")]
    fn only_named_payer_can_pay() {
        let mut c = setup();
        ctx(accounts(4), NEAR);
        let _ = c.pay_share("INV-1".into(), 0);
    }

    #[test]
    #[should_panic(expected = "attach exactly the share amount")]
    fn wrong_amount_is_rejected() {
        let mut c = setup();
        ctx(accounts(2), NEAR - 1);
        let _ = c.pay_share("INV-1".into(), 0);
    }

    #[test]
    #[should_panic(expected = "share is not open")]
    fn cannot_pay_twice() {
        let mut c = setup();
        ctx(accounts(2), NEAR);
        let _ = c.pay_share("INV-1".into(), 0);
        ctx(accounts(2), NEAR);
        let _ = c.pay_share("INV-1".into(), 0);
    }

    #[test]
    fn refund_returns_to_payer_and_marks_refunded() {
        let mut c = setup();
        ctx(accounts(2), NEAR);
        let _ = c.pay_share("INV-1".into(), 0);
        ctx(accounts(1), NEAR);
        let _ = c.refund_share("INV-1".into(), 0);
        let inv = c.get_invoice("INV-1".into()).unwrap();
        assert_eq!(inv.shares[0].state, ShareState::Refunded);
    }

    #[test]
    #[should_panic(expected = "only the clinic can refund")]
    fn only_clinic_can_refund() {
        let mut c = setup();
        ctx(accounts(2), NEAR);
        let _ = c.pay_share("INV-1".into(), 0);
        ctx(accounts(2), NEAR);
        let _ = c.refund_share("INV-1".into(), 0);
    }

    #[test]
    fn cancel_only_without_payments() {
        let mut c = setup();
        ctx(accounts(1), 0);
        c.cancel_invoice("INV-1".into());
        assert_eq!(c.get_status("INV-1".into()), Some(Status::Cancelled));
    }

    #[test]
    #[should_panic(expected = "cannot cancel an invoice with payments")]
    fn cannot_cancel_after_payment() {
        let mut c = setup();
        ctx(accounts(2), NEAR);
        let _ = c.pay_share("INV-1".into(), 0);
        ctx(accounts(1), 0);
        c.cancel_invoice("INV-1".into());
    }

    #[test]
    fn overdue_when_due_date_passed() {
        ctx(accounts(1), 0);
        let mut c = ClinicPay::new();
        c.create_invoice("INV-3".into(), "".into(), lines(), two_shares(), Some(U64(1)));
        assert_eq!(c.get_status("INV-3".into()), Some(Status::Overdue));
    }

    #[test]
    fn list_filters_by_payee() {
        let mut c = setup();
        ctx(accounts(4), 0);
        c.create_invoice("OTHER".into(), "".into(), lines(), two_shares(), None);
        assert_eq!(c.list_invoices(accounts(1), None, None).len(), 1);
        assert_eq!(c.list_invoices(accounts(4), None, None).len(), 1);
    }
}
