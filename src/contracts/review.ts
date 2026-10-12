export const REVIEW_ACTIONS = Object.freeze([
  'review_contract',
  'review_engineering',
] as const);

export type ReviewAction = typeof REVIEW_ACTIONS[number];

export const isReviewAction = (value: unknown): value is ReviewAction => (
  typeof value === 'string'
  && (REVIEW_ACTIONS as readonly string[]).includes(value)
);
