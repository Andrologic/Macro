use super::{invalid, Result};
use chrono::{DateTime, Datelike, Days, Local, NaiveDate, NaiveDateTime, TimeDelta, TimeZone};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Repeat {
    Once,
    Hourly { hours: u32 },
    Daily,
    Weekly { weekdays: Vec<u32> },
    Monthly,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TimingInput {
    first_at_ms: i64,
    repeat: Repeat,
}

#[derive(Deserialize, Serialize)]
pub(super) struct Timing {
    pub first_at_ms: i64,
    calendar: NaiveDateTime,
    repeat: Repeat,
}

impl TimingInput {
    pub(super) fn validate(self, now: i64) -> Result<Timing> {
        let first = DateTime::from_timestamp_millis(self.first_at_ms)
            .filter(|first| first.timestamp_millis() > now && first.year() <= 9999)
            .ok_or_else(|| invalid("INVALID_SCHEDULE_DATE", "firstAtMs"))?
            .with_timezone(&Local);
        match &self.repeat {
            Repeat::Hourly { hours } if *hours == 0 => {
                return Err(invalid("INVALID_SCHEDULE_INTERVAL", "hours"))
            }
            Repeat::Weekly { weekdays }
                if weekdays.len() > 7
                    || weekdays.iter().any(|day| *day > 6)
                    || !weekdays.contains(&first.weekday().num_days_from_monday()) =>
            {
                return Err(invalid("INVALID_SCHEDULE_WEEKDAYS", "weekdays"))
            }
            _ => {}
        }
        Ok(Timing {
            first_at_ms: self.first_at_ms,
            calendar: first.naive_local(),
            repeat: self.repeat,
        })
    }
}

impl Timing {
    /// Return the most recent due occurrence and the first future occurrence.
    pub(super) fn due(&self, next: i64, now: i64, tz: &impl TimeZone) -> (i64, Option<i64>) {
        match self.repeat {
            Repeat::Once => (next, None),
            Repeat::Hourly { hours } => {
                let step = i64::from(hours) * 3_600_000;
                let due = now - (now - next) % step;
                (
                    due,
                    due.checked_add(step)
                        .filter(|future| DateTime::from_timestamp_millis(*future).is_some()),
                )
            }
            _ => {
                let date = tz
                    .timestamp_millis_opt(now)
                    .single()
                    .expect("system clock is representable")
                    .date_naive();
                let last = self
                    .calendar_at(date, now, tz, false)
                    .unwrap_or(next)
                    .max(next);
                (last, self.calendar_at(date, now, tz, true))
            }
        }
    }

    fn calendar_at(
        &self,
        mut date: NaiveDate,
        now: i64,
        tz: &impl TimeZone,
        forward: bool,
    ) -> Option<i64> {
        loop {
            if date < self.calendar.date() {
                if !forward {
                    return None;
                }
                date = self.calendar.date();
            }
            let matches = match &self.repeat {
                Repeat::Monthly => date.day() == self.calendar.day(),
                Repeat::Weekly { weekdays } => {
                    weekdays.contains(&date.weekday().num_days_from_monday())
                }
                Repeat::Daily => true,
                _ => return None,
            };
            if matches {
                let time = if date == self.calendar.date() {
                    Some(self.first_at_ms)
                } else {
                    local_occurrence(tz, date.and_time(self.calendar.time()))
                };
                if let Some(time) = time.filter(|time| (*time > now) == forward) {
                    return Some(time);
                }
            }
            date = if forward {
                date.checked_add_days(Days::new(1))?
            } else {
                date.checked_sub_days(Days::new(1))?
            };
        }
    }
}

// A folded hour fires once. A skipped wall time moves to the first valid minute
// on the same day. If a time-zone change skips the entire date, skip that date.
fn local_occurrence(tz: &impl TimeZone, mut local: NaiveDateTime) -> Option<i64> {
    let date = local.date();
    while local.date() == date {
        if let Some(value) = tz.from_local_datetime(&local).earliest() {
            return Some(value.timestamp_millis());
        }
        local = local.checked_add_signed(TimeDelta::minutes(1))?;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn at(year: i32, month: u32, day: u32) -> i64 {
        Utc.with_ymd_and_hms(year, month, day, 9, 0, 0)
            .unwrap()
            .timestamp_millis()
    }

    fn timing(first: i64, repeat: Repeat) -> Timing {
        Timing {
            first_at_ms: first,
            calendar: DateTime::from_timestamp_millis(first).unwrap().naive_utc(),
            repeat,
        }
    }

    #[test]
    fn calendar_recurrence_coalesces_and_skips_missing_month_days() {
        let first = at(2032, 1, 31);
        let monthly = timing(first, Repeat::Monthly);
        assert_eq!(
            monthly.due(first, at(2032, 3, 2), &Utc),
            (first, Some(at(2032, 3, 31)))
        );
        assert_eq!(
            monthly.due(first, at(2032, 4, 1), &Utc),
            (at(2032, 3, 31), Some(at(2032, 5, 31)))
        );

        let first = at(2032, 1, 5);
        let weekly = timing(
            first,
            Repeat::Weekly {
                weekdays: vec![0, 3],
            },
        );
        assert_eq!(
            weekly.due(first, at(2032, 1, 12) - 1, &Utc),
            (at(2032, 1, 8), Some(at(2032, 1, 12)))
        );
        let daily = timing(first, Repeat::Daily);
        assert_eq!(
            daily.due(first, at(2032, 1, 10) - 1, &Utc),
            (at(2032, 1, 9), Some(at(2032, 1, 10)))
        );
        assert_eq!(
            timing(first, Repeat::Once).due(first, at(2032, 1, 10), &Utc),
            (first, None)
        );
    }
}
