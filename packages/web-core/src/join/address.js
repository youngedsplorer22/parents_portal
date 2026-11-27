/**
 * The address of a trip's public registration page: /join/<school>/<branch>/<trip>. The three words are fixed by the
 * server when the school and trip are created (a school with no branch uses "main"). They are NOT a secret and choose
 * nothing by themselves: the server decides, from its own records, whether that trip is public and open.
 */
export const SLUG = /^(?=.{1,70}$)[a-z0-9]+(-[a-z0-9]+)*$/;
/** The shape of a retired secret-link token (43 base64url characters), so an old link gets the right explanation. */
const OLD_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const isAddress = (a) => Boolean(a) && [a.school, a.branch, a.trip].every((w) => typeof w === "string" && SLUG.test(w));
export const isOldToken = (word) => typeof word === "string" && OLD_TOKEN.test(word) && !SLUG.test(word);
export const pagePath = (a) => `/join/${a.school}/${a.branch}/${a.trip}`;
