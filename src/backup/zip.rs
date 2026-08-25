//! Minimal ZIP (STORE method only), reader and writer.
//!
//! Why hand-rolled rather than a crate: a backup archive holds a SQLite file and
//! a directory of already-compressed blobs, so there is nothing to gain from
//! deflate — and STORE means the archive is a container, not a codec. The whole
//! format we need is three fixed-layout records. `web/src/lib/zip.ts` makes the
//! same call on the frontend for page bundles; this is its counterpart.
//!
//! ZIP rather than tar because the person opening one may well be on Windows in
//! the middle of a bad day, and double-clicking has to work.
//!
//! Deliberately NOT supported: compression, encryption, Zip64. The first two are
//! not wanted; the third bounds an archive to 4 GiB, which `create` checks for
//! rather than silently truncating.

use std::io::{self, Read, Seek, SeekFrom, Write};
use std::sync::LazyLock;

const LOCAL_SIG: u32 = 0x0403_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
/// General purpose bit 11: the name is UTF-8.
const UTF8_FLAG: u16 = 0x0800;
const STORE: u16 = 0;
/// 4 GiB — the point past which Zip64 becomes mandatory.
pub const MAX_ARCHIVE: u64 = u32::MAX as u64;

static CRC_TABLE: LazyLock<[u32; 256]> = LazyLock::new(|| {
    let mut t = [0u32; 256];
    for (n, slot) in t.iter_mut().enumerate() {
        let mut c = n as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    t
});

/// Running CRC-32 (IEEE), so an entry can be checksummed while it streams.
#[derive(Clone, Copy)]
pub struct Crc32(u32);

impl Default for Crc32 {
    fn default() -> Self {
        Self(0xffff_ffff)
    }
}

impl Crc32 {
    pub fn update(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = CRC_TABLE[((self.0 ^ u32::from(*b)) & 0xff) as usize] ^ (self.0 >> 8);
        }
    }
    pub fn finish(self) -> u32 {
        self.0 ^ 0xffff_ffff
    }
}

/// MS-DOS date and time, as ZIP stores them, from a Unix timestamp in seconds.
/// Out-of-range dates clamp to the epoch the format itself starts at (1980).
fn dos_datetime(unix_secs: i64) -> (u16, u16) {
    let Ok(dt) = time::OffsetDateTime::from_unix_timestamp(unix_secs) else {
        return (0x0021, 0); // 1980-01-01 00:00:00
    };
    let year = dt.year();
    if !(1980..=2107).contains(&year) {
        return (0x0021, 0);
    }
    let date = (((year - 1980) as u16) << 9) | ((u8::from(dt.month()) as u16) << 5) | dt.day() as u16;
    let time_ = ((dt.hour() as u16) << 11) | ((dt.minute() as u16) << 5) | (dt.second() as u16 / 2);
    (date, time_)
}

struct Central {
    name: String,
    crc: u32,
    size: u32,
    offset: u32,
    date: u16,
    time: u16,
}

/// Writes a STORE-only archive. Needs `Seek` because each local header carries
/// its entry's CRC and size, which are only known once the data has streamed
/// past — the header is written blank and patched. (The alternative, trailing
/// data descriptors, produces archives some tools read less happily.)
pub struct ZipWriter<W: Write + Seek> {
    out: W,
    entries: Vec<Central>,
}

impl<W: Write + Seek> ZipWriter<W> {
    pub fn new(out: W) -> Self {
        Self { out, entries: Vec::new() }
    }

    /// Streams one entry from `src`, checksumming as it goes. Never holds more
    /// than the copy buffer in memory, whatever the file's size.
    pub fn add<R: Read>(&mut self, name: &str, unix_secs: i64, src: &mut R) -> io::Result<()> {
        let (date, time_) = dos_datetime(unix_secs);
        let offset = self.out.stream_position()?;
        let name_bytes = name.as_bytes();

        // Local header, with CRC and sizes still unknown.
        self.out.write_all(&LOCAL_SIG.to_le_bytes())?;
        self.out.write_all(&20u16.to_le_bytes())?; // version needed
        self.out.write_all(&UTF8_FLAG.to_le_bytes())?;
        self.out.write_all(&STORE.to_le_bytes())?;
        self.out.write_all(&time_.to_le_bytes())?;
        self.out.write_all(&date.to_le_bytes())?;
        let placeholder = self.out.stream_position()?;
        self.out.write_all(&[0u8; 12])?; // crc + compressed + uncompressed
        self.out.write_all(&(name_bytes.len() as u16).to_le_bytes())?;
        self.out.write_all(&0u16.to_le_bytes())?; // extra field length
        self.out.write_all(name_bytes)?;

        let mut crc = Crc32::default();
        let mut size: u64 = 0;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            crc.update(&buf[..n]);
            size += n as u64;
            self.out.write_all(&buf[..n])?;
        }
        let end = self.out.stream_position()?;
        if end > MAX_ARCHIVE {
            return Err(io::Error::other(
                "archive would exceed 4 GiB, which this writer does not support (no Zip64)",
            ));
        }
        let crc = crc.finish();

        // Back-fill the header now that the numbers are known.
        self.out.seek(SeekFrom::Start(placeholder))?;
        self.out.write_all(&crc.to_le_bytes())?;
        self.out.write_all(&(size as u32).to_le_bytes())?;
        self.out.write_all(&(size as u32).to_le_bytes())?;
        self.out.seek(SeekFrom::Start(end))?;

        self.entries.push(Central {
            name: name.to_string(),
            crc,
            size: size as u32,
            offset: offset as u32,
            date,
            time: time_,
        });
        Ok(())
    }

    pub fn add_bytes(&mut self, name: &str, unix_secs: i64, data: &[u8]) -> io::Result<()> {
        self.add(name, unix_secs, &mut io::Cursor::new(data))
    }

    /// Writes the central directory and the end-of-archive record.
    pub fn finish(mut self) -> io::Result<W> {
        let start = self.out.stream_position()?;
        for e in &self.entries {
            let name = e.name.as_bytes();
            self.out.write_all(&CENTRAL_SIG.to_le_bytes())?;
            self.out.write_all(&20u16.to_le_bytes())?; // version made by
            self.out.write_all(&20u16.to_le_bytes())?; // version needed
            self.out.write_all(&UTF8_FLAG.to_le_bytes())?;
            self.out.write_all(&STORE.to_le_bytes())?;
            self.out.write_all(&e.time.to_le_bytes())?;
            self.out.write_all(&e.date.to_le_bytes())?;
            self.out.write_all(&e.crc.to_le_bytes())?;
            self.out.write_all(&e.size.to_le_bytes())?;
            self.out.write_all(&e.size.to_le_bytes())?;
            self.out.write_all(&(name.len() as u16).to_le_bytes())?;
            self.out.write_all(&0u16.to_le_bytes())?; // extra
            self.out.write_all(&0u16.to_le_bytes())?; // comment
            self.out.write_all(&0u16.to_le_bytes())?; // disk number
            self.out.write_all(&0u16.to_le_bytes())?; // internal attrs
            self.out.write_all(&0u32.to_le_bytes())?; // external attrs
            self.out.write_all(&e.offset.to_le_bytes())?;
            self.out.write_all(name)?;
        }
        let end = self.out.stream_position()?;
        let count = self.entries.len() as u16;
        self.out.write_all(&EOCD_SIG.to_le_bytes())?;
        self.out.write_all(&0u16.to_le_bytes())?; // this disk
        self.out.write_all(&0u16.to_le_bytes())?; // disk with central dir
        self.out.write_all(&count.to_le_bytes())?;
        self.out.write_all(&count.to_le_bytes())?;
        self.out.write_all(&((end - start) as u32).to_le_bytes())?;
        self.out.write_all(&(start as u32).to_le_bytes())?;
        self.out.write_all(&0u16.to_le_bytes())?; // comment length
        self.out.flush()?;
        Ok(self.out)
    }
}

/// One entry, as listed by the central directory — which is the authority on
/// what an archive contains.
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    pub size: u64,
    pub crc: u32,
    /// Offset of the entry's LOCAL header.
    pub offset: u64,
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}
fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg)
}

/// Lists the archive by reading its central directory.
///
/// Refuses anything it cannot honestly read — a compressed entry, a Zip64
/// archive, a truncated directory — rather than returning a partial listing that
/// a caller would mistake for the whole archive.
pub fn list<R: Read + Seek>(r: &mut R) -> io::Result<Vec<Entry>> {
    let len = r.seek(SeekFrom::End(0))?;
    if len < 22 {
        return Err(bad("not a ZIP archive: too short"));
    }
    // The EOCD sits at the end, possibly behind a comment of up to 64 KiB.
    let window = len.min(22 + 0xffff) as usize;
    r.seek(SeekFrom::End(-(window as i64)))?;
    let mut tail = vec![0u8; window];
    r.read_exact(&mut tail)?;
    let eocd = (0..=tail.len() - 22)
        .rev()
        .find(|&i| u32_at(&tail, i) == EOCD_SIG)
        .ok_or_else(|| bad("not a ZIP archive: no end-of-archive record"))?;

    let count = u16_at(&tail, eocd + 10) as usize;
    let dir_size = u32_at(&tail, eocd + 12) as usize;
    let dir_at = u32_at(&tail, eocd + 16) as u64;
    if dir_at == u32::MAX as u64 || count == 0xffff {
        return Err(bad("Zip64 archives are not supported"));
    }

    r.seek(SeekFrom::Start(dir_at))?;
    let mut dir = vec![0u8; dir_size];
    r.read_exact(&mut dir)?;

    let mut out = Vec::with_capacity(count);
    let mut at = 0usize;
    for _ in 0..count {
        if at + 46 > dir.len() || u32_at(&dir, at) != CENTRAL_SIG {
            return Err(bad("corrupt central directory"));
        }
        if u16_at(&dir, at + 10) != STORE {
            return Err(bad("compressed entries are not supported"));
        }
        let crc = u32_at(&dir, at + 16);
        let size = u32_at(&dir, at + 24) as u64;
        let name_len = u16_at(&dir, at + 28) as usize;
        let extra_len = u16_at(&dir, at + 30) as usize;
        let comment_len = u16_at(&dir, at + 32) as usize;
        let offset = u32_at(&dir, at + 42) as u64;
        let name_at = at + 46;
        if name_at + name_len > dir.len() {
            return Err(bad("corrupt central directory: truncated name"));
        }
        let name = String::from_utf8_lossy(&dir[name_at..name_at + name_len]).into_owned();
        out.push(Entry { name, size, crc, offset });
        at = name_at + name_len + extra_len + comment_len;
    }
    Ok(out)
}

/// Streams one entry's bytes into `w`, verifying its CRC before returning.
///
/// The check is the point: a backup archive is read exactly once, on the worst
/// day, and silently writing corrupt bytes over a live database would be the
/// single most destructive thing this codebase could do.
pub fn extract<R: Read + Seek, W: Write>(r: &mut R, e: &Entry, w: &mut W) -> io::Result<()> {
    r.seek(SeekFrom::Start(e.offset))?;
    let mut head = [0u8; 30];
    r.read_exact(&mut head)?;
    if u32_at(&head, 0) != LOCAL_SIG {
        return Err(bad("corrupt entry: bad local header"));
    }
    let name_len = u16_at(&head, 26) as u64;
    let extra_len = u16_at(&head, 28) as u64;
    r.seek(SeekFrom::Start(e.offset + 30 + name_len + extra_len))?;

    let mut crc = Crc32::default();
    let mut left = e.size;
    let mut buf = vec![0u8; 64 * 1024];
    while left > 0 {
        let want = buf.len().min(left as usize);
        r.read_exact(&mut buf[..want])?;
        crc.update(&buf[..want]);
        w.write_all(&buf[..want])?;
        left -= want as u64;
    }
    if crc.finish() != e.crc {
        return Err(bad("corrupt entry: checksum mismatch"));
    }
    w.flush()
}

/// Reads a whole entry into memory. For the small ones (the manifest) only.
pub fn read_all<R: Read + Seek>(r: &mut R, e: &Entry) -> io::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(e.size as usize);
    extract(r, e, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn roundtrip(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut w = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in entries {
            w.add_bytes(name, 1_787_000_000, data).expect("add");
        }
        w.finish().expect("finish").into_inner()
    }

    #[test]
    fn writes_an_archive_it_can_read_back() {
        let big = vec![0xABu8; 200 * 1024]; // spans several copy buffers
        let bytes = roundtrip(&[
            ("backup.json", b"{\"format\":1}".to_vec()),
            ("bramblekeep.db", big.clone()),
            ("files/deadbeef", b"blob".to_vec()),
        ]);

        let mut r = Cursor::new(bytes);
        let entries = list(&mut r).expect("list");
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["backup.json", "bramblekeep.db", "files/deadbeef"]);

        assert_eq!(read_all(&mut r, &entries[0]).unwrap(), b"{\"format\":1}");
        assert_eq!(read_all(&mut r, &entries[1]).unwrap(), big);
        assert_eq!(read_all(&mut r, &entries[2]).unwrap(), b"blob");
    }

    #[test]
    fn an_empty_entry_survives_the_round_trip() {
        let bytes = roundtrip(&[("empty", Vec::new())]);
        let mut r = Cursor::new(bytes);
        let entries = list(&mut r).expect("list");
        assert_eq!(entries[0].size, 0);
        assert!(read_all(&mut r, &entries[0]).unwrap().is_empty());
    }

    /// The guard that matters: a flipped byte must be caught, not written out.
    #[test]
    fn a_corrupted_entry_is_refused() {
        let mut bytes = roundtrip(&[("bramblekeep.db", vec![1u8; 5_000])]);
        // Flip a byte inside the entry's data, past every header.
        let at = bytes.len() / 2;
        bytes[at] ^= 0xff;

        let mut r = Cursor::new(bytes);
        let entries = list(&mut r).expect("list");
        let err = read_all(&mut r, &entries[0]).expect_err("checksum must fail");
        assert!(err.to_string().contains("checksum"), "got {err}");
    }

    #[test]
    fn refuses_something_that_is_not_an_archive() {
        let mut r = Cursor::new(b"this is not a zip file, not even close".to_vec());
        assert!(list(&mut r).is_err());
        let mut empty = Cursor::new(Vec::new());
        assert!(list(&mut empty).is_err());
    }

    #[test]
    fn crc32_matches_the_known_vector() {
        let mut c = Crc32::default();
        c.update(b"123456789");
        assert_eq!(c.finish(), 0xCBF4_3926); // the standard CRC-32/ISO-HDLC check value
    }
}
