// Presentation-only help for specific fields: a hint line and an optional "See example"
// image. Keyed by tour type, then field key. It does not add, rename, reorder or validate
// fields (those come from the server's definitions), so the two can't drift apart in
// anything that matters. Images live in /public/guides and load only when opened.

const PASSPORT_HINT = "Fill in the form exactly as per passport.";
// Every example image carries a banner saying it is a sample; the alt text says so too.
const SAMPLE_NOTE = " The image is marked SAMPLE – NOT A REAL DOCUMENT.";
const AADHAAR_HINT = "Please enter your full name and date of birth exactly as printed on your Aadhaar card. Do not change the order or spelling.";

const AADHAAR_EXAMPLE = {
  src: "/guides/aadhaar-name-dob.jpg",
  alt:
    "Example Aadhaar card. The Name field (ANANYA SHARMA) is marked as the full name and the DOB field (15/07/1995) " +
    "as the date of birth, both as printed on the Aadhaar. A note says to enter them exactly as printed and not to change the order or spelling." + SAMPLE_NOTE,
};

export const GUIDANCE = {
  international: {
    firstName: {
      hint: PASSPORT_HINT,
      example: {
        src: "/guides/passport-first-name.jpg",
        alt:
          "Example Indian passport data page. The Given Name(s) field (ANANYA) is marked as the first name, " +
          "as in the passport. A banner says to fill in the form exactly as per passport." + SAMPLE_NOTE,
      },
    },
    lastName: {
      hint: PASSPORT_HINT,
      example: {
        src: "/guides/passport-last-name.jpg",
        alt:
          "Example Indian passport data page. The Surname field (SHARMA) is marked as the last name, " +
          "as in the passport. A banner says to fill in the form exactly as per passport." + SAMPLE_NOTE,
      },
    },
  },
  domestic: {
    fullName: { hint: AADHAAR_HINT, example: AADHAAR_EXAMPLE },
    dateOfBirth: { hint: AADHAAR_HINT, example: AADHAAR_EXAMPLE },
  },
};

/** Guidance for one field of one tour, or undefined. */
export const guidanceFor = (tourType, key) => GUIDANCE[tourType]?.[key];
