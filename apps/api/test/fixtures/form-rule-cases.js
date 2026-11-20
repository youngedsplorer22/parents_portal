// Shared inputs for the name and phone rules: the backend tests and the frontend parity test both use them.
export const NAME_OK = ["Asha Rao", "José Ñúñez", "O'Brien", "Mary-Jane Watson", "D’Souza", "R. K. Sharma", "अनन्या शर्मा", "李小龍", "Zoë Saldaña", "Nguyễn Văn An"];
export const NAME_BAD = ["Asha2", "<b>Asha</b>", "---", "''", "Asha_Rao", "asha@example.com", "Robert'); DROP TABLE x;--", "12345", "Asha‮Rao", "😀"];
// Mobile numbers: exactly 10 digits, no country code.
export const PHONE_OK = ["9876543210", "0123456789", "1234567890", "6000000000"];
export const PHONE_BAD = [
  "987654321", "98765432101", "919876543210", "+919876543210", "+91 9876543210", "+91-9876543210", "091 9876543210",
  "98765 43210", "98765-43210", "(987)6543210", "98765abcde", "phone12345", "9876543210 ext 2",
  "\uFF19\uFF18\uFF17\uFF16\uFF15\uFF14\uFF13\uFF12\uFF11\uFF10", "\u0669\u0668\u0667\u0666\u0665\u0664\u0663\u0662\u0661\u0660",
  "98765\u200B43210", "", "+",
];
