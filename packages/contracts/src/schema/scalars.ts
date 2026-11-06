import * as Schema from 'effect/Schema';

// The calendar check rejects normalized dates such as February 30, which Date.parse accepts.
const timestampPattern =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** Validates offset timestamps without transforming their wire representation. */
const timestampSchema = Schema.String.check(
  Schema.isPattern(timestampPattern),
  Schema.makeFilter(
    (value) => {
      const year = Number(value.slice(0, 4)),
        month = Number(value.slice(5, 7)),
        day = Number(value.slice(8, 10));

      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const lastDay = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

      return day <= lastDay;
    },
    { toJsonSchema: () => ({ format: 'date-time' }) },
  ),
);

/** Accepts HTTP URLs including loopback callback receivers. */
const httpUrlSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      try {
        return /^https?:$/.test(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { toJsonSchema: () => ({ format: 'uri' }) },
  ),
);

/** Retains the previously accepted 26-character Crockford identity alphabet. */
const ulidSchema = Schema.String.check(Schema.isPattern(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/u));

/** Keeps integers exactly representable in JavaScript and in generated wire schemas. */
const safeIntegerSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
);

const positiveIntegerSchema = safeIntegerSchema.check(Schema.isGreaterThan(0));

const nonnegativeIntegerSchema = safeIntegerSchema.check(Schema.isGreaterThanOrEqualTo(0));

export {
  timestampSchema,
  httpUrlSchema,
  ulidSchema,
  safeIntegerSchema,
  positiveIntegerSchema,
  nonnegativeIntegerSchema,
};
