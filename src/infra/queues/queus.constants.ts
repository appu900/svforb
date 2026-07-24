

export const QUEUE_NAMES = {
  NOTIFICATION_EMAIL: 'queue.notification.email',
  NOTIFICATION_PUSH:  'queue.notification.push',
  LISTINGS:           'queue.listings',           // listing expiry, proximity re-query
  REPORTS:            'queue.reports',            // impact CSV export, aggregation
  BILLING:            'queue.billing',            // trial expiry checks, stripe webhooks
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];



export const NOTIFICATION_EMAIL_JOBS = {
  VERIFY_EMAIL:         'email.verify_email',
  WELCOME:              'email.welcome',
  PASSWORD_RESET:       'email.password_reset',
  SITE_ACCESS_GRANTED:  'email.site_access_granted',
  TRIAL_EXPIRING:       'email.trial_expiring',
  PLAN_ACTIVATED:       'email.plan_activated',
} as const;

// ── Notification push job names ───────────────────────────────────────────────

export const NOTIFICATION_PUSH_JOBS = {
  VERIFY_EMAIL:        'push.verify_email',
  WELCOME:             'push.welcome',
  SITE_ACCESS_GRANTED: 'push.site_access_granted',
  NEW_LISTING_NEARBY:  'push.new_listing_nearby',
  LISTING_CLAIMED:     'push.listing_claimed',
  TRIAL_EXPIRING:      'push.trial_expiring',
} as const;

// ── Listings job names ────────────────────────────────────────────────────────

export const LISTINGS_JOBS = {
  NEW_LISTING:               'listing.new',
  EXPIRE_LISTING:            'listing.expire',
  EXPIRE_SITE_NOTIFICATIONS: 'listing.expire_site_notifications',
  SWEEP_EXPIRED_LISTINGS:    'listing.sweep_expired',
  PROXIMITY_REQUERY:         'listing.proximity_requery',
  IMPACT_AGGREGATE:          'listing.impact_aggregate',
} as const;

// ── Reports job names ─────────────────────────────────────────────────────────

export const REPORTS_JOBS = {
  EXPORT_IMPACT_CSV:    'report.export_impact_csv',
  AGGREGATE_MONTHLY:    'report.aggregate_monthly',
} as const;

// ── Billing job names ─────────────────────────────────────────────────────────

export const BILLING_JOBS = {
  CHECK_TRIAL_EXPIRY:   'billing.check_trial_expiry',
  STRIPE_WEBHOOK:       'billing.stripe_webhook',
} as const;

// ── Default BullMQ job options ────────────────────────────────────────────────
// Import and spread into Queue.add() calls for consistent retry behaviour.

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff:  { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { count: 500 },
  removeOnFail:     { count: 200 },
} as const;