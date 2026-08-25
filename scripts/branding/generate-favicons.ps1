# Regenerates the static Theskwoff Hotel favicon / browser-icon set in public/
# from the approved logo source committed next to this script.
#
#   pwsh -NoProfile -File scripts/branding/generate-favicons.ps1
#
# Uses only Windows' built-in System.Drawing (no npm image dependency). The
# generated files are committed, so this script only needs to run when the
# approved logo itself changes.
#
# Output (all in public/):
#   favicon.ico            16 + 32 + 48 (PNG-compressed ICO entries)
#   favicon-16x16.png      favicon-32x32.png
#   apple-touch-icon.png   180x180 (iOS home screen)
#   icon-192.png           icon-512.png (site.webmanifest / Android)
#   og-image.png           1200x630 social/search preview card

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..\..")
$source = Join-Path $scriptDir "theskwoff-logo-source.jpg"
$outDir = Join-Path $repoRoot "public"

# Tight square crop around the emblem, measured from the source's bright-pixel
# bounding box (the silver ring): centre (633, 539), ring diameter 1021px.
# ~4% breathing room only — no wide empty margin, which is what makes a
# favicon look shrunken in a browser tab.
$cropX = 103
$cropY = 9
$cropSize = 1060

function Add-Contrast {
    # The source is a photograph of a physical emblem, so it carries a soft
    # glow around the silver ring. Shrunk below ~48px that glow lifts the dark
    # ground and the whole icon flattens into mid-grey mush. A linear contrast
    # stretch about mid-grey restores the black/silver separation that makes
    # the ring + bed readable in a browser tab. Larger sizes keep the
    # untouched photographic rendering.
    param([System.Drawing.Bitmap]$Bitmap, [single]$Scale)

    $translate = [single](0.5 * (1.0 - $Scale))
    $matrix = New-Object System.Drawing.Imaging.ColorMatrix
    $matrix.Matrix00 = $Scale; $matrix.Matrix11 = $Scale; $matrix.Matrix22 = $Scale
    $matrix.Matrix40 = $translate; $matrix.Matrix41 = $translate; $matrix.Matrix42 = $translate
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    $attrs.SetColorMatrix($matrix)

    $out = New-Object System.Drawing.Bitmap $Bitmap.Width, $Bitmap.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($out)
    $rect = New-Object System.Drawing.Rectangle 0, 0, $Bitmap.Width, $Bitmap.Height
    $g.DrawImage($Bitmap, $rect, 0, 0, $Bitmap.Width, $Bitmap.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
    $g.Dispose()
    $attrs.Dispose()
    return $out
}

function New-Square {
    param([System.Drawing.Bitmap]$Source, [int]$Size)

    # Progressive halving keeps the fine ring/bed edges clean at small sizes;
    # a single bicubic step from ~1060px straight to 16px aliases badly.
    $current = $Source.Clone([System.Drawing.Rectangle]::new(0, 0, $Source.Width, $Source.Height), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    while ($current.Width -gt $Size * 2) {
        $half = [Math]::Max($Size, [int]($current.Width / 2))
        $next = New-Object System.Drawing.Bitmap $half, $half, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($next)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.DrawImage($current, (New-Object System.Drawing.Rectangle 0, 0, $half, $half))
        $g.Dispose()
        $current.Dispose()
        $current = $next
    }

    $target = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($target)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($current, (New-Object System.Drawing.Rectangle 0, 0, $Size, $Size))
    $g.Dispose()
    $current.Dispose()

    if ($Size -le 48) {
        $scale = [single]1.5
        if ($Size -le 16) { $scale = [single]1.75 }
        $boosted = Add-Contrast -Bitmap $target -Scale $scale
        $target.Dispose()
        return $boosted
    }
    return $target
}

function Save-Png {
    param([System.Drawing.Bitmap]$Bitmap, [string]$Path)
    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ("  {0}  {1}x{2}  {3} bytes" -f (Split-Path -Leaf $Path), $Bitmap.Width, $Bitmap.Height, (Get-Item $Path).Length)
}

$sourceBmp = [System.Drawing.Bitmap]::FromFile($source)
try {
    $cropped = $sourceBmp.Clone(
        [System.Drawing.Rectangle]::new($cropX, $cropY, $cropSize, $cropSize),
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
} finally {
    $sourceBmp.Dispose()
}

Write-Output "Generating favicon assets into $outDir"

$pngSizes = @{ 16 = "favicon-16x16.png"; 32 = "favicon-32x32.png"; 180 = "apple-touch-icon.png"; 192 = "icon-192.png"; 512 = "icon-512.png" }
foreach ($size in ($pngSizes.Keys | Sort-Object)) {
    $bmp = New-Square -Source $cropped -Size $size
    Save-Png -Bitmap $bmp -Path (Join-Path $outDir $pngSizes[$size])
    $bmp.Dispose()
}

# --- favicon.ico (16/32/48, PNG-compressed entries) ---------------------------
$icoSizes = @(16, 32, 48)
$pngBlobs = @()
foreach ($size in $icoSizes) {
    $bmp = New-Square -Source $cropped -Size $size
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBlobs += , $ms.ToArray()
    $ms.Dispose()
    $bmp.Dispose()
}

$icoPath = Join-Path $outDir "favicon.ico"
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0)                     # reserved
$bw.Write([uint16]1)                     # type: icon
$bw.Write([uint16]$icoSizes.Count)
$offset = 6 + (16 * $icoSizes.Count)
for ($i = 0; $i -lt $icoSizes.Count; $i++) {
    $bw.Write([byte]$icoSizes[$i])       # width  (0 would mean 256)
    $bw.Write([byte]$icoSizes[$i])       # height
    $bw.Write([byte]0)                   # palette colors
    $bw.Write([byte]0)                   # reserved
    $bw.Write([uint16]1)                 # color planes
    $bw.Write([uint16]32)                # bits per pixel
    $bw.Write([uint32]$pngBlobs[$i].Length)
    $bw.Write([uint32]$offset)
    $offset += $pngBlobs[$i].Length
}
foreach ($blob in $pngBlobs) { $bw.Write($blob) }
$bw.Flush(); $bw.Dispose(); $fs.Dispose()
Write-Output ("  favicon.ico  16/32/48  {0} bytes" -f (Get-Item $icoPath).Length)

# --- og-image.png (1200x630 card: emblem centred on the logo's dark ground) ---
$og = New-Object System.Drawing.Bitmap 1200, 630, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($og)
$g.Clear([System.Drawing.Color]::FromArgb(255, 26, 26, 30))
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$emblem = New-Square -Source $cropped -Size 520
$g.DrawImage($emblem, (New-Object System.Drawing.Rectangle 340, 55, 520, 520))
$emblem.Dispose()
$g.Dispose()
Save-Png -Bitmap $og -Path (Join-Path $outDir "og-image.png")
$og.Dispose()

$cropped.Dispose()
Write-Output "Done."
