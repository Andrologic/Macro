//! Syntax diagnostics for the existing ordinary JSON codec. This pass creates
//! no value tree and performs no numeric conversion. Messages are checked
//! against the resident Bun oracle, separately from authored exact JSON errors.
use crate::argentic_core::native::{SyntaxError, Text};

type Result<T> = std::result::Result<T, SyntaxError>;
#[derive(Clone, Copy, PartialEq, Eq)]
enum Token {
    End,
    String,
    Number,
    Value,
    OpenArray,
    CloseArray,
    OpenObject,
    CloseObject,
    Colon,
    Comma,
    Dot,
    Identifier(usize, usize),
}
fn error(message: impl Into<Text>) -> SyntaxError {
    let mut text = Text::from("JSON Parse error: ");
    text.push(&message.into());
    SyntaxError { message: text }
}
struct Lexer<'a> {
    units: &'a [u16],
    i: usize,
}
impl Lexer<'_> {
    fn next(&mut self) -> Result<Token> {
        while self
            .units
            .get(self.i)
            .is_some_and(|u| matches!(u, 9 | 10 | 13 | 32))
        {
            self.i += 1;
        }
        let Some(&u) = self.units.get(self.i) else {
            return Ok(Token::End);
        };
        self.i += 1;
        Ok(match u {
            91 => Token::OpenArray,
            93 => Token::CloseArray,
            123 => Token::OpenObject,
            125 => Token::CloseObject,
            58 => Token::Colon,
            44 => Token::Comma,
            // A dot is diagnosed by the parser context, like punctuation.
            // A decimal without digits is still rejected in the number lexer.
            46 => Token::Dot,
            34 => {
                self.string()?;
                Token::String
            }
            39 => return Err(error("Single quotes (') are not allowed in JSON")),
            45 | 48..=57 => {
                if u == 45 {
                    if !self.units.get(self.i).is_some_and(|u| matches!(u, 48..=57)) {
                        return Err(error("Invalid number"));
                    }
                    self.i += 1;
                }
                let first = if u == 45 { self.units[self.i - 1] } else { u };
                if first != 48 {
                    while self.units.get(self.i).is_some_and(|u| matches!(u, 48..=57)) {
                        self.i += 1;
                    }
                }
                if self.units.get(self.i) == Some(&46) {
                    self.i += 1;
                    if !self.units.get(self.i).is_some_and(|u| matches!(u, 48..=57)) {
                        return Err(error("Invalid digits after decimal point"));
                    }
                    while self.units.get(self.i).is_some_and(|u| matches!(u, 48..=57)) {
                        self.i += 1;
                    }
                }
                if self
                    .units
                    .get(self.i)
                    .is_some_and(|u| matches!(u, 69 | 101))
                {
                    let start = self.i;
                    self.i += 1;
                    if self.units.get(self.i).is_some_and(|u| matches!(u, 43 | 45)) {
                        self.i += 1;
                    }
                    if !self.units.get(self.i).is_some_and(|u| matches!(u, 48..=57)) {
                        self.i = start;
                    } else {
                        while self.units.get(self.i).is_some_and(|u| matches!(u, 48..=57)) {
                            self.i += 1;
                        }
                    }
                }
                Token::Number
            }
            65..=90 | 97..=122 | 95 | 36 => {
                let start = self.i - 1;
                for word in ["true", "false", "null"] {
                    let n = word.len();
                    if self
                        .units
                        .get(start..start + n)
                        .is_some_and(|s| s.iter().copied().eq(word.encode_utf16()))
                    {
                        self.i = start + n;
                        return Ok(Token::Value);
                    }
                }
                while self
                    .units
                    .get(self.i)
                    .is_some_and(|u| matches!(u,65..=90 | 97..=122 | 48..=57 | 95 | 36))
                {
                    self.i += 1;
                }
                Token::Identifier(start, self.i)
            }
            _ => {
                let mut text = Text::from("Unrecognized token '");
                text.push(&Text::from_units(vec![u]));
                text.push(&Text::from("'"));
                return Err(error(text));
            }
        })
    }
    fn string(&mut self) -> Result<()> {
        while let Some(&u) = self.units.get(self.i) {
            self.i += 1;
            if u == 34 {
                return Ok(());
            }
            if u < 32 {
                return Err(error("Unterminated string"));
            }
            if u != 92 {
                continue;
            }
            let Some(&escape) = self.units.get(self.i) else {
                return Err(error("Unterminated string"));
            };
            self.i += 1;
            match escape {
                34 | 92 | 47 | 98 | 102 | 110 | 114 | 116 => {}
                117 => {
                    if self.units.len() - self.i < 4 {
                        return Err(error("\\u must be followed by 4 hex digits"));
                    }
                    let hex = &self.units[self.i..self.i + 4];
                    if !hex.iter().all(|u| matches!(u,48..=57 | 65..=70 | 97..=102)) {
                        let mut text = Text::from("\"\\u");
                        text.push(&Text::from_units(hex.to_vec()));
                        text.push(&Text::from("\" is not a valid unicode escape"));
                        return Err(error(text));
                    }
                    self.i += 4;
                }
                u => {
                    let mut text = Text::from("Invalid escape character ");
                    text.push(&Text::from_units(vec![u]));
                    return Err(error(text));
                }
            }
        }
        Err(error("Unterminated string"))
    }
}
#[derive(Clone, Copy)]
enum State {
    Value,
    ArrayStart,
    ArrayValue,
    ArrayEnd,
    ObjectStart,
    ObjectKey,
    ObjectColon,
    ObjectValue,
    ObjectEnd,
    RootEnd,
}
fn unexpected(token: Token, units: &[u16]) -> SyntaxError {
    match token {
        Token::Identifier(start, end) => {
            let mut text = Text::from("Unexpected identifier \"");
            text.push(&Text::from_units(units[start..end].to_vec()));
            text.push(&Text::from("\""));
            error(text)
        }
        Token::End => error("Unexpected EOF"),
        Token::CloseArray => error("Unexpected token ']'"),
        Token::CloseObject => error("Unexpected token '}'"),
        Token::Colon => error("Unexpected token ':'"),
        Token::Comma => error("Unexpected token ','"),
        Token::Dot => error("Unexpected token '.'"),
        _ => error("Unable to parse JSON string"),
    }
}
pub(super) fn validate(raw: &Text) -> Result<()> {
    let mut lex = Lexer {
        units: raw.units(),
        i: 0,
    };
    let mut token = lex.next()?;
    let mut states = vec![State::RootEnd, State::Value];
    while let Some(state) = states.pop() {
        match state {
            State::Value => {
                match token {
                    Token::OpenArray => states.push(State::ArrayStart),
                    Token::OpenObject => states.push(State::ObjectStart),
                    Token::String | Token::Number | Token::Value => {}
                    _ => return Err(unexpected(token, lex.units)),
                }
                token = lex.next()?;
            }
            State::ArrayStart => {
                if token == Token::CloseArray {
                    token = lex.next()?;
                } else {
                    states.extend([State::ArrayEnd, State::Value]);
                }
            }
            State::ArrayValue => {
                if token == Token::CloseArray {
                    return Err(error("Unexpected comma at the end of array expression"));
                }
                states.extend([State::ArrayEnd, State::Value]);
            }
            State::ArrayEnd => match token {
                Token::CloseArray => token = lex.next()?,
                Token::Comma => {
                    token = lex.next()?;
                    states.push(State::ArrayValue);
                }
                _ => return Err(error("Expected ']'")),
            },
            State::ObjectStart => match token {
                Token::CloseObject => token = lex.next()?,
                Token::String => {
                    token = lex.next()?;
                    states.push(State::ObjectColon);
                }
                _ => return Err(error("Expected '}'")),
            },
            State::ObjectKey => {
                if token != Token::String {
                    return Err(error("Property name must be a string literal"));
                }
                token = lex.next()?;
                states.push(State::ObjectColon);
            }
            State::ObjectColon => {
                if token != Token::Colon {
                    return Err(error(
                        "Expected ':' before value in object property definition",
                    ));
                }
                token = lex.next()?;
                states.push(State::ObjectValue);
            }
            State::ObjectValue => states.extend([State::ObjectEnd, State::Value]),
            State::ObjectEnd => match token {
                Token::CloseObject => token = lex.next()?,
                Token::Comma => {
                    token = lex.next()?;
                    states.push(State::ObjectKey);
                }
                _ => return Err(error("Expected '}'")),
            },
            State::RootEnd => {
                if token != Token::End {
                    return Err(error("Unable to parse JSON string"));
                }
            }
        }
    }
    Ok(())
}
