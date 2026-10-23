use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Locale {
    En,
    Az,
}

impl Default for Locale {
    fn default() -> Self {
        Self::En
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GeneratorKind {
    Skip,
    Null,
    Constant,
    Sequence,
    Int,
    Decimal,
    Boolean,
    Date,
    Time,
    Uuid,
    List,
    Regex,
    LoremWords,
    LoremSentence,
    FirstName,
    LastName,
    FullName,
    Email,
    Phone,
    City,
    StreetAddress,
    Company,
    ProductName,
    Price,
    Status,
    Color,
    Url,
    Ip,
    ForeignKey,
}

impl Default for GeneratorKind {
    fn default() -> Self {
        Self::Skip
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Generator {
    pub kind: GeneratorKind,
    #[serde(default)]
    pub constant: Option<String>,
    #[serde(default)]
    pub start: Option<i64>,
    #[serde(default)]
    pub step: Option<i64>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub precision: Option<u32>,
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    #[serde(default)]
    pub items: Option<Vec<String>>,
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub words: Option<u32>,
    #[serde(default)]
    pub locale: Option<Locale>,
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub column: Option<String>,
}

impl Default for Generator {
    fn default() -> Self {
        Self {
            kind: GeneratorKind::Skip,
            constant: None,
            start: None,
            step: None,
            min: None,
            max: None,
            precision: None,
            date_from: None,
            date_to: None,
            items: None,
            pattern: None,
            words: None,
            locale: None,
            table: None,
            column: None,
        }
    }
}

impl Generator {
    pub fn new(kind: GeneratorKind) -> Self {
        Self {
            kind,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FkTarget {
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestDataColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub auto_increment: bool,
    pub unique: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreign_key: Option<FkTarget>,
    pub suggested: Generator,
}

#[derive(Debug, Clone)]
pub struct GenerationColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub unique: bool,
    pub generator: Generator,
    pub null_percent: f64,
    pub fk_values: Vec<Value>,
}

#[derive(Debug, Clone)]
pub struct RowGenerator {
    rng: Rng,
    columns: Vec<GenerationColumn>,
    counters: Vec<u64>,
    seen: Vec<HashSet<String>>,
    locale: Locale,
}

impl RowGenerator {
    pub fn new(seed: u64, columns: Vec<GenerationColumn>, locale: Locale) -> Self {
        let counters = vec![0; columns.len()];
        let seen = columns.iter().map(|_| HashSet::new()).collect();
        Self {
            rng: Rng::new(seed),
            columns,
            counters,
            seen,
            locale,
        }
    }

    pub fn column_names(&self) -> Vec<String> {
        self.columns
            .iter()
            .map(|column| column.name.clone())
            .collect()
    }

    pub fn row(&mut self, row_index: u64) -> AppResult<Vec<Value>> {
        let mut values = Vec::with_capacity(self.columns.len());
        for index in 0..self.columns.len() {
            values.push(self.value_for(index, row_index)?);
        }
        Ok(values)
    }

    fn value_for(&mut self, index: usize, row_index: u64) -> AppResult<Value> {
        let column = &self.columns[index];

        if column.generator.kind == GeneratorKind::Null {
            if column.nullable {
                return Ok(Value::Null);
            }
            return Err(AppError::Config(format!(
                "column '{}' is NOT NULL and cannot use the NULL generator",
                column.name
            )));
        }

        if column.nullable
            && !column.unique
            && column.null_percent > 0.0
            && chance(&mut self.rng, column.null_percent)
        {
            return Ok(Value::Null);
        }

        let attempts = if column.unique { 64 } else { 1 };
        for _ in 0..attempts {
            let candidate = generate_raw(
                &mut self.rng,
                &column.generator,
                &column.data_type,
                row_index,
                &mut self.counters[index],
                &column.fk_values,
                column.generator.locale.unwrap_or(self.locale),
            )?;

            if !column.unique {
                return Ok(candidate);
            }

            if self.seen[index].insert(value_key(&candidate)) {
                return Ok(candidate);
            }
        }

        Err(AppError::Config(format!(
            "could not generate a unique value for column '{}'",
            column.name
        )))
    }
}

#[derive(Debug, Clone)]
struct Rng {
    state: u64,
}

impl Rng {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut value = self.state;
        value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        value ^ (value >> 31)
    }

    fn below(&mut self, limit: usize) -> usize {
        if limit == 0 {
            0
        } else {
            (self.next_u64() % limit as u64) as usize
        }
    }
}

fn chance(rng: &mut Rng, percent: f64) -> bool {
    let percent = percent.clamp(0.0, 100.0);
    (rng.next_u64() % 10_000) < (percent * 100.0).round() as u64
}

fn value_key(value: &Value) -> String {
    match value {
        Value::String(text) => format!("s:{text}"),
        Value::Number(number) => format!("n:{number}"),
        Value::Bool(flag) => format!("b:{flag}"),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

fn generate_raw(
    rng: &mut Rng,
    generator: &Generator,
    data_type: &str,
    row_index: u64,
    counter: &mut u64,
    fk_values: &[Value],
    locale: Locale,
) -> AppResult<Value> {
    let data_type = data_type.to_ascii_lowercase();

    let value = match generator.kind {
        GeneratorKind::Skip | GeneratorKind::Null => Value::Null,
        GeneratorKind::Constant => Value::String(generator.constant.clone().unwrap_or_default()),
        GeneratorKind::Sequence => {
            let start = generator.start.unwrap_or(1);
            let step = generator.step.unwrap_or(1);
            let value = start.wrapping_add((row_index as i64).wrapping_mul(step));
            Value::from(value)
        }
        GeneratorKind::Int => {
            let min = generator.min.unwrap_or(1.0) as i64;
            let max = generator.max.unwrap_or(10_000.0) as i64;
            random_int(rng, min, max)
        }
        GeneratorKind::Decimal | GeneratorKind::Price => {
            let min = generator.min.unwrap_or(if generator.kind == GeneratorKind::Price {
                1.0
            } else {
                0.0
            });
            let max = generator.max.unwrap_or(if generator.kind == GeneratorKind::Price {
                500.0
            } else {
                1000.0
            });
            let precision = generator.precision.unwrap_or(2).min(10);
            random_decimal(rng, min, max, precision)
        }
        GeneratorKind::Boolean => Value::Bool(rng.next_u64() & 1 == 0),
        GeneratorKind::Date => random_date(rng, generator, &data_type),
        GeneratorKind::Time => random_time(rng),
        GeneratorKind::Uuid => Value::String(random_uuid(rng)),
        GeneratorKind::List => {
            let items = generator
                .items
                .as_ref()
                .filter(|items| !items.is_empty())
                .cloned()
                .unwrap_or_else(|| vec!["active".to_string(), "inactive".to_string()]);
            Value::String(items[rng.below(items.len())].clone())
        }
        GeneratorKind::Regex => Value::String(regex_lite(
            rng,
            generator.pattern.as_deref().unwrap_or("[A-Z]{3}[0-9]{3}"),
        )),
        GeneratorKind::LoremWords => {
            let words = generator.words.unwrap_or(4).clamp(1, 24) as usize;
            Value::String(lorem_words(rng, words))
        }
        GeneratorKind::LoremSentence => Value::String(lorem_sentence(rng)),
        GeneratorKind::FirstName => Value::String(first_name(rng, locale).to_string()),
        GeneratorKind::LastName => Value::String(last_name(rng, locale).to_string()),
        GeneratorKind::FullName => Value::String(full_name(rng, locale)),
        GeneratorKind::Email => Value::String(unique_email(rng, locale, counter)),
        GeneratorKind::Phone => Value::String(phone(rng, locale)),
        GeneratorKind::City => Value::String(city(rng, locale).to_string()),
        GeneratorKind::StreetAddress => Value::String(street_address(rng, locale)),
        GeneratorKind::Company => Value::String(company(rng, locale).to_string()),
        GeneratorKind::ProductName => Value::String(product_name(rng, locale)),
        GeneratorKind::Status => Value::String(status(rng).to_string()),
        GeneratorKind::Color => Value::String(color(rng).to_string()),
        GeneratorKind::Url => Value::String(url(rng, locale)),
        GeneratorKind::Ip => Value::String(ip(rng)),
        GeneratorKind::ForeignKey => {
            if fk_values.is_empty() {
                Value::Null
            } else {
                let start = rng.below(fk_values.len());
                let index = (start + *counter as usize) % fk_values.len();
                *counter += 1;
                fk_values[index].clone()
            }
        }
    };

    Ok(value)
}

fn random_int(rng: &mut Rng, min: i64, max: i64) -> Value {
    let (min, max) = if min <= max { (min, max) } else { (max, min) };
    let span = max as i128 - min as i128 + 1;
    let offset = (rng.next_u64() as u128 % span as u128) as i128;
    Value::from((min as i128 + offset) as i64)
}

fn random_decimal(rng: &mut Rng, min: f64, max: f64, precision: u32) -> Value {
    let (min, max) = if min <= max { (min, max) } else { (max, min) };
    let unit = rng.next_u64() as f64 / u64::MAX as f64;
    let raw = min + (max - min) * unit;
    let factor = 10f64.powi(precision as i32);
    let rounded = (raw * factor).round() / factor;
    Value::from(rounded)
}

fn random_date(rng: &mut Rng, generator: &Generator, data_type: &str) -> Value {
    let from = generator
        .date_from
        .as_deref()
        .and_then(parse_date)
        .unwrap_or_else(|| days_from_civil(2020, 1, 1));
    let to = generator
        .date_to
        .as_deref()
        .and_then(parse_date)
        .unwrap_or_else(|| days_from_civil(2025, 12, 31));
    let (from, to) = if from <= to { (from, to) } else { (to, from) };
    let span = (to - from + 1).max(1) as u64;
    let day = from + (rng.next_u64() % span) as i64;
    let (year, month, date) = civil_from_days(day);

    if data_type.contains("timestamp") || data_type.contains("datetime") {
        let seconds = rng.next_u64() % 86_400;
        Value::String(format!(
            "{year:04}-{month:02}-{date:02} {:02}:{:02}:{:02}",
            seconds / 3600,
            (seconds % 3600) / 60,
            seconds % 60
        ))
    } else if is_time_only(&data_type) {
        random_time(rng)
    } else {
        Value::String(format!("{year:04}-{month:02}-{date:02}"))
    }
}

fn random_time(rng: &mut Rng) -> Value {
    let seconds = rng.next_u64() % 86_400;
    Value::String(format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    ))
}

fn is_time_only(data_type: &str) -> bool {
    data_type.starts_with("time") && !data_type.starts_with("timestamp")
}

fn parse_date(text: &str) -> Option<i64> {
    let mut parts = text.trim().split('-');
    let year = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<i64>().ok()?;
    let day = parts.next()?.parse::<i64>().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_shifted = (month + 9) % 12;
    let day_of_year = (153 * month_shifted + 2) / 5 + day - 1;
    let day_of_era =
        year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year =
        day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_shifted = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_shifted + 2) / 5 + 1;
    let month = if month_shifted < 10 {
        month_shifted + 3
    } else {
        month_shifted - 9
    };
    (year + if month <= 2 { 1 } else { 0 }, month, day)
}

fn random_uuid(rng: &mut Rng) -> String {
    let mut bytes = [0u8; 16];
    let first = rng.next_u64().to_be_bytes();
    let second = rng.next_u64().to_be_bytes();
    bytes[..8].copy_from_slice(&first);
    bytes[8..].copy_from_slice(&second);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn regex_lite(rng: &mut Rng, pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut output = String::new();
    let mut index = 0;

    while index < chars.len() {
        if chars[index] == '[' {
            if let Some(end) = (index + 1..chars.len()).find(|&item| chars[item] == ']') {
                let allowed = class_chars(&chars[index + 1..end]);
                let (count, next) = parse_quantifier(&chars, end + 1);
                index = next;
                for _ in 0..count {
                    if !allowed.is_empty() {
                        output.push(allowed[rng.below(allowed.len())]);
                    }
                }
                continue;
            }
        }

        let literal = chars[index];
        let (count, next) = parse_quantifier(&chars, index + 1);
        index = next;
        for _ in 0..count {
            output.push(literal);
        }
    }

    output
}

fn parse_quantifier(chars: &[char], index: usize) -> (usize, usize) {
    if index < chars.len() && chars[index] == '{' {
        if let Some(end) = (index + 1..chars.len()).find(|&item| chars[item] == '}') {
            let text: String = chars[index + 1..end].iter().collect();
            if let Ok(count) = text.trim().parse::<usize>() {
                return (count.min(1000), end + 1);
            }
        }
    }
    (1, index)
}

fn class_chars(class: &[char]) -> Vec<char> {
    let mut output = Vec::new();
    let mut index = 0;
    while index < class.len() {
        if index + 2 < class.len() && class[index + 1] == '-' {
            let start = class[index] as u32;
            let end = class[index + 2] as u32;
            if start <= end && end - start <= 256 {
                for code in start..=end {
                    if let Some(character) = char::from_u32(code) {
                        output.push(character);
                    }
                }
            }
            index += 3;
        } else {
            output.push(class[index]);
            index += 1;
        }
    }
    output
}

const EN_FIRST: &[&str] = &[
    "James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda",
    "William", "Elizabeth", "David", "Barbara", "Richard", "Susan", "Joseph", "Jessica",
    "Thomas", "Sarah", "Daniel", "Karen", "Matthew", "Nancy", "Anthony", "Lisa",
];

const EN_LAST: &[&str] = &[
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Wilson", "Anderson", "Thomas",
    "Taylor", "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris",
];

const AZ_FIRST: &[&str] = &[
    "Əli", "Aysel", "Vəli", "Leyla", "Orxan", "Nigar", "Rəşad", "Günel", "Elvin",
    "Aynur", "Murad", "Sevinc", "Tural", "Lalə", "Kamran", "Zeynəb", "Emin", "Aysu",
    "Fərid", "Nərmin", "Cavid", "Aytən", "Rauf", "Səbinə",
];

const AZ_LAST: &[&str] = &[
    "Məmmədov", "Əliyeva", "Həsənov", "Quliyeva", "Hüseynov", "Rəhimova", "İsmayılov",
    "Abbasova", "Nəbiyev", "Xəlilova", "Süleymanov", "Məlikova", "Kərimov", "Cəfərova",
    "Mustafayev", "Nəsirova", "Ağayev", "Vəliyeva", "Babayev", "Şükürova", "Qasımov",
    "Hacıyeva",
];

const EN_CITIES: &[&str] = &[
    "New York", "London", "Chicago", "Seattle", "Austin", "Boston", "Denver", "Miami",
    "Phoenix", "Portland", "San Diego", "Toronto",
];

const AZ_CITIES: &[&str] = &[
    "Bakı", "Gəncə", "Sumqayıt", "Şəki", "Lənkəran", "Mingəçevir", "Naxçıvan", "Şirvan",
    "Quba", "Qusar", "Xaçmaz", "Şamaxı", "İsmayıllı", "Zaqatala", "Qəbələ", "Ağdaş",
    "Bərdə", "Yevlax", "Salyan", "Masallı",
];

const EN_STREETS: &[&str] = &[
    "Main Street", "Oak Avenue", "Maple Drive", "Cedar Lane", "Pine Road", "Elm Street",
    "Park Avenue", "Lake View", "Hillcrest", "Sunset Boulevard", "River Road", "Chestnut",
];

const AZ_STREETS: &[&str] = &[
    "Nizami küçəsi", "Füzuli küçəsi", "Rəşid Behbudov küçəsi", "Azadlıq prospekti",
    "Neftçilər prospekti", "Heydər Əliyev prospekti", "Bülbül prospekti",
    "28 May küçəsi", "Tbilisi prospekti", "Xaqani küçəsi", "Səməd Vurğun küçəsi",
    "Zərifə Əliyeva küçəsi",
];

const EN_COMPANIES: &[&str] = &[
    "Acme Corp", "Globex", "Initech", "Umbrella Group", "Stark Industries", "Wayne Enterprises",
    "Northwind", "Contoso", "Fabrikam", "Adventure Works", "Blue River", "Summit Labs",
];

const AZ_COMPANIES: &[&str] = &[
    "AzərTelekom", "Bakı Sənaye", "Xəzər Ticarət", "Şəki Qida", "Gəncə Logistika",
    "Naxçıvan Enerji", "Qafqaz İnşaat", "Caspian Tech", "Araz Market", "Şirvan Tekstil",
    "Bakı Finance", "Günəş Group",
];

const EN_PRODUCTS: &[&str] = &[
    "Laptop", "Wireless Mouse", "Office Chair", "Coffee Maker", "Running Shoes", "Backpack",
    "Smart Watch", "Desk Lamp", "Bluetooth Speaker", "Water Bottle", "Notebook", "Sunglasses",
];

const AZ_PRODUCTS: &[&str] = &[
    "Noutbuk", "Simsiz siçan", "Ofis kreslosu", "Qəhvə maşını", "İdman ayaqqabısı",
    "Arxa çanta", "Ağıllı saat", "Masa lampası", "Bluetooth dinamik", "Su qabı",
    "Dəftər", "Gün eynəyi",
];

const STATUSES: &[&str] = &[
    "active", "inactive", "pending", "archived", "draft", "published", "cancelled",
    "completed", "failed", "processing",
];

const COLORS: &[&str] = &[
    "red", "green", "blue", "yellow", "black", "white", "orange", "purple", "gray", "brown",
    "pink", "cyan",
];

const LOREM_WORDS: &[&str] = &[
    "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed",
    "do", "eiusmod", "tempor", "incididunt", "ut", "labore", "et", "dolore", "magna",
    "aliqua", "enim", "ad", "minim", "veniam", "quis", "nostrud", "exercitation",
    "ullamco", "laboris", "nisi", "aliquip", "ex", "ea", "commodo", "consequat",
    "duis", "aute", "irure", "in", "reprehenderit", "voluptate", "velit", "esse",
    "cillum", "fugiat", "nulla", "pariatur", "excepteur", "sint", "occaecat",
    "cupidatat", "non", "proident", "sunt", "culpa", "qui", "officia", "deserunt",
    "mollit", "anim", "id", "est", "laborum",
];

const AZ_PHONE_PREFIXES: &[&str] = &["50", "51", "55", "70", "77"];

fn first_name(rng: &mut Rng, locale: Locale) -> &'static str {
    let list = match locale {
        Locale::En => EN_FIRST,
        Locale::Az => AZ_FIRST,
    };
    list[rng.below(list.len())]
}

fn last_name(rng: &mut Rng, locale: Locale) -> &'static str {
    let list = match locale {
        Locale::En => EN_LAST,
        Locale::Az => AZ_LAST,
    };
    list[rng.below(list.len())]
}

fn full_name(rng: &mut Rng, locale: Locale) -> String {
    format!("{} {}", first_name(rng, locale), last_name(rng, locale))
}

fn unique_email(rng: &mut Rng, locale: Locale, counter: &mut u64) -> String {
    let first = ascii_slug(first_name(rng, locale));
    let last = ascii_slug(last_name(rng, locale));
    let suffix = if *counter == 0 {
        String::new()
    } else {
        counter.to_string()
    };
    *counter += 1;
    format!("{first}.{last}{suffix}@example.com")
}

fn ascii_slug(text: &str) -> String {
    let mut output = String::new();
    for character in text.chars() {
        let mapped = match character {
            'ə' | 'Ə' => 'e',
            'ı' | 'İ' => 'i',
            'ş' | 'Ş' => 's',
            'ç' | 'Ç' => 'c',
            'ğ' | 'Ğ' => 'g',
            'ö' | 'Ö' => 'o',
            'ü' | 'Ü' => 'u',
            other => other,
        };
        if mapped.is_ascii_alphanumeric() {
            output.push(mapped.to_ascii_lowercase());
        }
    }
    if output.is_empty() {
        "user".to_string()
    } else {
        output
    }
}

fn phone(rng: &mut Rng, locale: Locale) -> String {
    match locale {
        Locale::Az => {
            let prefix = AZ_PHONE_PREFIXES[rng.below(AZ_PHONE_PREFIXES.len())];
            format!(
                "+994 {prefix} {:03} {:02} {:02}",
                rng.below(1000),
                rng.below(100),
                rng.below(100)
            )
        }
        Locale::En => format!(
            "+1 555 {:03} {:04}",
            rng.below(1000),
            rng.below(10_000)
        ),
    }
}

fn city(rng: &mut Rng, locale: Locale) -> &'static str {
    let list = match locale {
        Locale::En => EN_CITIES,
        Locale::Az => AZ_CITIES,
    };
    list[rng.below(list.len())]
}

fn street_address(rng: &mut Rng, locale: Locale) -> String {
    let list = match locale {
        Locale::En => EN_STREETS,
        Locale::Az => AZ_STREETS,
    };
    let street = list[rng.below(list.len())];
    format!("{} {}", 1 + rng.below(200), street)
}

fn company(rng: &mut Rng, locale: Locale) -> &'static str {
    let list = match locale {
        Locale::En => EN_COMPANIES,
        Locale::Az => AZ_COMPANIES,
    };
    list[rng.below(list.len())]
}

fn product_name(rng: &mut Rng, locale: Locale) -> String {
    let list = match locale {
        Locale::En => EN_PRODUCTS,
        Locale::Az => AZ_PRODUCTS,
    };
    format!("{} {}", list[rng.below(list.len())], 100 + rng.below(900))
}

fn status(rng: &mut Rng) -> &'static str {
    STATUSES[rng.below(STATUSES.len())]
}

fn color(rng: &mut Rng) -> &'static str {
    COLORS[rng.below(COLORS.len())]
}

fn url(rng: &mut Rng, locale: Locale) -> String {
    let name = ascii_slug(company(rng, locale));
    let word = LOREM_WORDS[rng.below(LOREM_WORDS.len())];
    format!("https://{name}.example.com/{word}")
}

fn ip(rng: &mut Rng) -> String {
    format!(
        "{}.{}.{}.{}",
        1 + rng.below(223),
        rng.below(256),
        rng.below(256),
        1 + rng.below(254)
    )
}

fn lorem_words(rng: &mut Rng, count: usize) -> String {
    let mut words = Vec::with_capacity(count);
    for _ in 0..count {
        words.push(LOREM_WORDS[rng.below(LOREM_WORDS.len())]);
    }
    words.join(" ")
}

fn lorem_sentence(rng: &mut Rng) -> String {
    let count = 6 + rng.below(7);
    let words = lorem_words(rng, count);
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => format!("{}{}.", first.to_ascii_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

fn is_integer_type(data_type: &str) -> bool {
    data_type.contains("int")
        || data_type.contains("serial")
        || data_type.contains("integer")
        || data_type == "number"
}

fn is_decimal_type(data_type: &str) -> bool {
    data_type.contains("decimal")
        || data_type.contains("numeric")
        || data_type.contains("float")
        || data_type.contains("double")
        || data_type.contains("real")
        || data_type.contains("money")
}

fn is_text_type(data_type: &str) -> bool {
    data_type.contains("char")
        || data_type.contains("text")
        || data_type.contains("varchar")
        || data_type.contains("string")
        || data_type.contains("clob")
        || data_type.contains("citext")
}

fn is_uuid_type(data_type: &str) -> bool {
    data_type.contains("uuid") || data_type.contains("uniqueidentifier")
}

fn is_boolean_type(data_type: &str) -> bool {
    data_type.contains("bool")
        || data_type.starts_with("bit")
        || data_type == "tinyint(1)"
}

pub fn ensure_unique_generator(generator: Generator, data_type: &str) -> Generator {
    if matches!(
        generator.kind,
        GeneratorKind::Email
            | GeneratorKind::Phone
            | GeneratorKind::Uuid
            | GeneratorKind::Ip
            | GeneratorKind::Sequence
            | GeneratorKind::ForeignKey
            | GeneratorKind::Date
            | GeneratorKind::Time
            | GeneratorKind::Boolean
            | GeneratorKind::Skip
            | GeneratorKind::Null
    ) {
        return generator;
    }

    let data_type = data_type.to_ascii_lowercase();
    if is_integer_type(&data_type) || is_decimal_type(&data_type) {
        Generator {
            kind: GeneratorKind::Sequence,
            start: Some(1),
            step: Some(1),
            ..Generator::default()
        }
    } else if is_text_type(&data_type) || is_uuid_type(&data_type) {
        Generator::new(GeneratorKind::Uuid)
    } else {
        generator
    }
}

pub fn suggest_generator(
    name: &str,
    data_type: &str,
    auto_increment: bool,
    unique: bool,
    foreign_key: Option<&FkTarget>,
) -> Generator {
    let data_type = data_type.to_ascii_lowercase();
    let compact: String = name
        .chars()
        .filter(|character| !matches!(character, '_' | ' ' | '-'))
        .collect::<String>()
        .to_ascii_lowercase();

    if auto_increment {
        return Generator::new(GeneratorKind::Skip);
    }

    if let Some(target) = foreign_key {
        return Generator {
            kind: GeneratorKind::ForeignKey,
            table: Some(target.table.clone()),
            column: Some(target.column.clone()),
            ..Generator::default()
        };
    }

    if compact.contains("email") {
        return Generator::new(GeneratorKind::Email);
    }
    if compact.contains("phone") || compact.contains("mobile") || compact.contains("telephone") {
        return Generator::new(GeneratorKind::Phone);
    }
    if compact.contains("firstname") || compact.contains("givenname") {
        return Generator::new(GeneratorKind::FirstName);
    }
    if compact.contains("lastname") || compact.contains("surname") || compact.contains("familyname")
    {
        return Generator::new(GeneratorKind::LastName);
    }
    if compact == "name" || compact.contains("fullname") || compact.contains("username") {
        return Generator::new(GeneratorKind::FullName);
    }
    if compact.contains("city") || compact.contains("town") {
        return Generator::new(GeneratorKind::City);
    }
    if compact.contains("street") || compact.contains("address") {
        return Generator::new(GeneratorKind::StreetAddress);
    }
    if compact.contains("company") || compact.contains("organization") || compact == "org" {
        return Generator::new(GeneratorKind::Company);
    }
    if compact.contains("product") || compact == "item" || compact.contains("itemname") {
        return Generator::new(GeneratorKind::ProductName);
    }
    if compact.contains("status") || compact == "state" {
        return Generator::new(GeneratorKind::Status);
    }
    if compact.contains("color") || compact.contains("colour") {
        return Generator::new(GeneratorKind::Color);
    }
    if compact.contains("url") || compact.contains("website") || compact.contains("link") {
        return Generator::new(GeneratorKind::Url);
    }
    if compact.contains("ipaddress") || compact == "ip" {
        return Generator::new(GeneratorKind::Ip);
    }
    if is_uuid_type(&data_type) || compact == "guid" {
        return Generator::new(GeneratorKind::Uuid);
    }
    if is_boolean_type(&data_type) {
        return Generator::new(GeneratorKind::Boolean);
    }

    let timestamp = data_type.contains("timestamp") || data_type.contains("datetime");
    let time_only = !timestamp && is_time_only(&data_type);
    let date_name = compact.contains("createdat")
        || compact.contains("updatedat")
        || compact.ends_with("date")
        || compact.starts_with("date");
    if time_only {
        return Generator::new(GeneratorKind::Time);
    }
    if timestamp || data_type.contains("date") || date_name {
        return Generator {
            kind: GeneratorKind::Date,
            date_from: Some("2020-01-01".to_string()),
            date_to: Some("2025-12-31".to_string()),
            ..Generator::default()
        };
    }

    if compact.ends_with("id") && !unique {
        return Generator {
            kind: GeneratorKind::Int,
            min: Some(1.0),
            max: Some(10_000.0),
            ..Generator::default()
        };
    }

    if unique {
        if is_integer_type(&data_type) || is_decimal_type(&data_type) {
            return Generator {
                kind: GeneratorKind::Sequence,
                start: Some(1),
                step: Some(1),
                ..Generator::default()
            };
        }
        return Generator::new(GeneratorKind::Uuid);
    }

    if is_integer_type(&data_type) {
        return Generator {
            kind: GeneratorKind::Int,
            min: Some(1.0),
            max: Some(10_000.0),
            ..Generator::default()
        };
    }

    if is_decimal_type(&data_type) && !compact.contains("price") {
        return Generator {
            kind: GeneratorKind::Decimal,
            min: Some(0.0),
            max: Some(1000.0),
            precision: Some(2),
            ..Generator::default()
        };
    }

    if compact.contains("price") || compact.contains("amount") || compact.contains("cost") {
        return Generator {
            kind: GeneratorKind::Price,
            min: Some(1.0),
            max: Some(500.0),
            precision: Some(2),
            ..Generator::default()
        };
    }

    if data_type.contains("json") {
        return Generator::new(GeneratorKind::LoremSentence);
    }

    if is_text_type(&data_type) {
        return Generator {
            kind: GeneratorKind::LoremWords,
            words: Some(4),
            ..Generator::default()
        };
    }

    Generator {
        kind: GeneratorKind::LoremWords,
        words: Some(4),
        ..Generator::default()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use serde_json::Value;

    use super::{
        Generator, GeneratorKind, GenerationColumn, Locale, RowGenerator,
    };

    fn column(name: &str, data_type: &str, kind: GeneratorKind) -> GenerationColumn {
        GenerationColumn {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable: true,
            unique: false,
            generator: Generator::new(kind),
            null_percent: 0.0,
            fk_values: Vec::new(),
        }
    }

    fn rows(seed: u64, columns: Vec<GenerationColumn>, count: usize) -> Vec<Vec<Value>> {
        let mut generator = RowGenerator::new(seed, columns, Locale::En);
        (0..count)
            .map(|index| generator.row(index as u64).unwrap())
            .collect()
    }

    #[test]
    fn same_seed_produces_the_same_rows() {
        let build = || {
            vec![
                column("first_name", "varchar", GeneratorKind::FirstName),
                column("email", "varchar", GeneratorKind::Email),
                column("score", "int", GeneratorKind::Int),
                column("created_at", "timestamp", GeneratorKind::Date),
            ]
        };

        assert_eq!(rows(42, build(), 50), rows(42, build(), 50));
        assert_ne!(rows(42, build(), 50), rows(43, build(), 50));
    }

    #[test]
    fn unique_emails_never_repeat_within_a_run() {
        let mut email = column("email", "varchar", GeneratorKind::Email);
        email.unique = true;
        let generated = rows(7, vec![email], 1000);
        let values: HashSet<String> = generated
            .into_iter()
            .map(|row| match row[0].clone() {
                Value::String(text) => text,
                other => panic!("expected a string, got {other}"),
            })
            .collect();
        assert_eq!(values.len(), 1000);
    }

    #[test]
    fn az_phone_numbers_use_the_expected_format() {
        let phone = column("phone", "varchar", GeneratorKind::Phone);
        let mut generator = RowGenerator::new(1, vec![phone], Locale::Az);
        for index in 0..100 {
            let value = generator.row(index).unwrap()[0].clone();
            let Value::String(text) = value else {
                panic!("expected a phone string");
            };
            assert!(text.starts_with("+994 "));
            assert!(matches!(
                &text[5..7],
                "50" | "51" | "55" | "70" | "77"
            ));
            assert_eq!(text.len(), 17);
        }
    }

    #[test]
    fn not_null_columns_never_receive_null() {
        let mut name = column("name", "varchar", GeneratorKind::FirstName);
        name.nullable = false;
        name.null_percent = 100.0;
        let generated = rows(3, vec![name], 100);
        assert!(generated.iter().all(|row| !row[0].is_null()));
    }

    #[test]
    fn foreign_keys_only_use_the_provided_ids() {
        let mut fk = column("user_id", "int", GeneratorKind::ForeignKey);
        fk.fk_values = vec![Value::from(3), Value::from(8), Value::from(13)];
        let allowed: HashSet<String> = fk
            .fk_values
            .iter()
            .map(|value| value.to_string())
            .collect();
        let generated = rows(99, vec![fk], 100);
        assert!(generated
            .iter()
            .all(|row| allowed.contains(&row[0].to_string())));
    }
}
