const WINDOWS_DEVICE_STEM =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u

/** Win32 canonicalization, device names, and NTFS streams must not alias ordinary files. */
export function isSafeWindowsFileNameSegment(segment: string): boolean {
  if (!segment || segment.includes('/') || segment.includes('\\') || /[ .]$/u.test(segment)) {
    return false
  }
  const deviceStem = segment.split('.')[0]?.toUpperCase() ?? ''
  if (WINDOWS_DEVICE_STEM.test(deviceStem)) {
    return false
  }
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]
    if (segment.charCodeAt(i) <= 31 || (char !== undefined && '<>:"|?*'.includes(char))) {
      return false
    }
  }
  return true
}

/** Win32 trims trailing spaces before device-name detection. */
export function isSafeWindowsOperationFileNameSegment(segment: string): boolean {
  return (
    isSafeWindowsFileNameSegment(segment) &&
    !WINDOWS_DEVICE_STEM.test((segment.split('.')[0] ?? '').trimEnd().toUpperCase())
  )
}
