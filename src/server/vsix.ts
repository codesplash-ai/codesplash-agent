import extension from "../../extensions/vscode/extension.cjs" with { type: "text" }
import manifest from "../../extensions/vscode/package.json"

function crc32(data: Buffer) {
  let value = 0xffffffff
  for (const byte of data) {
    value ^= byte
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}
/** Small deterministic stored ZIP; every entry name and byte comes from bundled assets. */
export function vscodePackage(): Buffer {
  const files: Record<string, string> = {
    "extension/package.json": JSON.stringify(manifest, null, 2),
    "extension/extension.cjs": extension,
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>',
    "extension.vsixmanifest": `<?xml version="1.0"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="codesplash" Version="${manifest.version}" Publisher="codesplash-ai"/><DisplayName>CodeSplash</DisplayName><Description xml:space="preserve">Local CodeSplash daemon integration</Description><Tags>ai,coding</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.90.0"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>`,
  }
  const local: Buffer[] = [],
    central: Buffer[] = []
  let offset = 0
  for (const [name, source] of Object.entries(files)) {
    const filename = Buffer.from(name),
      data = Buffer.from(source),
      crc = crc32(data)
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50)
    h.writeUInt16LE(20, 4)
    h.writeUInt32LE(crc, 14)
    h.writeUInt32LE(data.length, 18)
    h.writeUInt32LE(data.length, 22)
    h.writeUInt16LE(filename.length, 26)
    local.push(h, filename, data)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(data.length, 20)
    c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(filename.length, 28)
    c.writeUInt32LE(offset, 42)
    central.push(c, filename)
    offset += h.length + filename.length + data.length
  }
  const dir = Buffer.concat(central),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, dir, end])
}
