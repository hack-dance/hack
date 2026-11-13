//! Read capability shared by locked inspection and lease-free status. It cannot
//! dispatch effects, execute guest programs or grant cleanup authority.
use super::*;

pub(in crate::provider) trait Inspection {
    fn incarnation(&self) -> &str;
    fn boot_id(&self) -> Result<&str, CandidateError>;
    #[cfg(any(target_os = "macos", test))]
    fn verify(&self) -> Result<(), CandidateError>;
    fn get(&self, path: &str) -> Result<Value, CandidateError>;
    fn probe_status(&self, id: &str) -> Result<Option<String>, CandidateError>;
}

impl Inspection for Engine<'_> {
    fn incarnation(&self) -> &str {
        self.guest.incarnation()
    }
    fn boot_id(&self) -> Result<&str, CandidateError> {
        Ok(self.guest.boot_id())
    }
    #[cfg(any(target_os = "macos", test))]
    fn verify(&self) -> Result<(), CandidateError> {
        self.guest.verify()
    }
    fn get(&self, path: &str) -> Result<Value, CandidateError> {
        self.request(Method::GET, path, None)
    }
    fn probe_status(&self, id: &str) -> Result<Option<String>, CandidateError> {
        self.probe_status(id)
    }
}

#[cfg(target_os = "macos")]
impl Inspection for Observer<'_> {
    fn incarnation(&self) -> &str {
        self.guest.incarnation()
    }
    fn boot_id(&self) -> Result<&str, CandidateError> {
        self.guest.boot_id()
    }
    #[cfg(any(target_os = "macos", test))]
    fn verify(&self) -> Result<(), CandidateError> {
        self.guest.verify()
    }
    fn get(&self, path: &str) -> Result<Value, CandidateError> {
        self.get(path)
    }
    fn probe_status(&self, id: &str) -> Result<Option<String>, CandidateError> {
        read_probe_status(&self.transport, id, || self.guest.verify())
    }
}
