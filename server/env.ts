export type Env = {
  DB: D1Database;
  APP_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Comma-separated owner (super user) emails. Empty = nobody can sign in. */
  OWNER_EMAILS?: string;
  DEV_ORIGIN?: string;
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
