export type Role = 'owner' | 'member';
export type User = { id: number; email: string; name: string | null; picture: string | null; role: Role };

export type AuditEntry = {
  id: number;
  created_at: number;
  user_id: number | null;
  user_email: string | null;
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  method: string | null;
  path: string | null;
  status: number | null;
  target_id: string | null;
  detail: Record<string, string | number | boolean | null> | null;
  ip: string | null;
  country: string | null;
  user_agent: string | null;
};
export type AuditPage = { items: AuditEntry[]; next_before: number | null };

export type AdminUser = {
  email: string;
  role: Role | null;
  status: 'active' | 'invited' | 'revoked';
  user_id: number | null;
  name: string | null;
  joined_at: number | null;
  last_login_at: number | null;
  active_sessions: number;
  granted_by: string | null;
  granted_at: number | null;
  note: string | null;
};

export type CategoryKind = 'expense' | 'income' | 'transfer';
export type Keyword = { id: number; keyword: string | null; regex: string | null; builtin: boolean };
export type Category = { id: number; name: string; kind: CategoryKind; builtin: boolean; keywords: Keyword[] };

export type TxnType = 'debit' | 'credit';
export type Transaction = {
  id: number;
  date: string;
  amount: number;
  type: TxnType;
  description: string;
  category_id: number | null;
  category_name: string | null;
  bank: string | null;
  account_type: string | null;
  account_last4: string | null;
  remark: string | null;
  merchant: string | null;
  transfer_pair_id: number | null;
};

export type TransferSide = { id: number; date: string; description: string; bank: string | null; account_last4: string | null };
export type TransferCandidate = { amount: number; debit: TransferSide; credit: TransferSide };

export type NewTransaction = {
  date: string;
  amount: number;
  type: TxnType;
  description: string;
  category_id: number | null;
  bank?: string | null;
  account_type?: 'savings' | 'credit_card' | 'cash' | 'other' | null;
  account_last4?: string | null;
  remark?: string | null;
};

export type Summary = {
  income: number;
  spend: number;
  net: number;
  count: number;
  uncategorized: number;
  months: { month: string; income: number; spend: number }[];
  by_category: { category_id: number | null; name: string; spend: number; count: number }[];
};

export type Budget = { id: number; category_id: number; name: string; amount: number; spent: number };

export type Person = { id: number; name: string; note: string | null };

export type Loan = {
  id: number;
  person_id: number;
  person_name: string;
  direction: 'lent' | 'borrowed';
  title: string;
  amount: number;
  paid: number;
  outstanding: number;
  date: string;
  note: string | null;
  payments: { id: number; amount: number; date: string; note: string | null }[];
};

export type Emi = {
  id: number;
  title: string;
  lender: string | null;
  installment: number;
  frequency_unit: 'days' | 'weeks' | 'months' | 'years';
  frequency_value: number;
  start_date: string;
  end_date: string;
  note: string | null;
  installments_total: number;
  installments_done: number;
  next_due: string | null;
  remaining_amount: number;
};
