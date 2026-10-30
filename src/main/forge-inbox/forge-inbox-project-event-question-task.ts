/** One follow-up task per delivery, so a task that declines again ends in a person's decision. */
export const MAX_QUESTION_TASKS = 1

/** The turn a drain launches for an ask_user: the first preparation, or the task it owes. */
export type ProjectEventQuestionAttempt = 'prepare' | 'answer'
