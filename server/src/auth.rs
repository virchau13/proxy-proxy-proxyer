pub const HASH_LENGTH: usize = 64;
use std::ops::Deref;

use crate::PROXY_PW;
use chrono::Timelike;

pub fn make_auth_with_hour(uri: &str, hour: u16) -> String {
    sha256::digest(format!("{hour}#{}#{uri}", PROXY_PW.deref()))
}

#[tracing::instrument]
pub fn verify_auth(auth: &str, uri: &str) -> bool {
    let hour = chrono::offset::Utc::now().hour();
    for offset in 23..=25 {
        let hour = (hour + offset) % 24;
        let should_be = make_auth_with_hour(uri, hour as u16);
        if should_be == auth {
            return true;
        } else {
            tracing::debug!("auth does not match {should_be}");
        }
    }
    false
}

