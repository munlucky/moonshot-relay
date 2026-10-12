// Generated from src/contracts/review.ts. Edit the source and run npm run build.
export const REVIEW_ACTIONS = Object.freeze([
    'review_contract',
    'review_engineering',
]);
export const isReviewAction = (value) => (typeof value === 'string'
    && REVIEW_ACTIONS.includes(value));
