//! Total physical memory, used to scale a document's raster budget to the machine.
//!
//! The reference app reads `ProcessInfo.processInfo.physicalMemory`; this is the same number from
//! the platform directly, so the core crate keeps no dependencies for it.

#[cfg(windows)]
pub fn total_memory() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: `status` is a plain, fully initialised struct; the call only writes into it.
    unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut status) == 0 {
            return None;
        }
        Some(status.ullTotalPhys)
    }
}

#[cfg(not(windows))]
pub fn total_memory() -> Option<u64> {
    // Linux and anything else with procfs.
    if let Ok(text) = std::fs::read_to_string("/proc/meminfo") {
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                let kib: u64 = rest.split_whitespace().next()?.parse().ok()?;
                return Some(kib * 1024);
            }
        }
    }
    // macOS.
    let out = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok()?;
    String::from_utf8(out.stdout).ok()?.trim().parse().ok()
}
