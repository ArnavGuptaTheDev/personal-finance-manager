export type Env = {
  DB: D1Database;
  APP_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Comma-separated owner (super user) emails. Empty = nobody can sign in. */
  OWNER_EMAILS?: string;
  DEV_ORIGIN?: string;
  /** Audit entries older than this many days are deleted by the daily job (default 400). */
  AUDIT_RETENTION_DAYS?: string;
  /** Upper bound on audit rows kept; the oldest are trimmed beyond it (default 500000). */
  AUDIT_MAX_ROWS?: string;
};

export type Role = 'owner' | 'member';

export type SessionUser = { id: number; email: string; role: Role };

/** Extra information a handler attaches to the audit entry for its request. */
export type AuditNote = {
  action?: string;
  outcome?: 'success' | 'failure' | 'denied';
  /** For requests without a session (sign-in), who the entry is about. */
  userId?: number;
  email?: string;
  targetId?: string | number;
  detail?: Record<string, string | number | boolean | null>;
};

export type AppEnv = {
  Bindings: Env;
  Variables: {
    userId: number;
    user: SessionUser;
    audit?: AuditNote;
  };
};
