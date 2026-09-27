# Generates media/icon.png (128x128): three agent nodes linked into a shared memory core
# on a dark-teal -> indigo rounded square. No deps: System.Drawing only.
# Run: powershell -ExecutionPolicy Bypass -File extension/scripts/make-icon.ps1
Add-Type -AssemblyName System.Drawing
$S = 128
$out = Join-Path $PSScriptRoot '..\media\icon.png'
$bmp = New-Object System.Drawing.Bitmap $S, $S
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)

# rounded-square background, diagonal gradient
$r = 28; $d = $r * 2; $w = $S - 1
$bg = New-Object System.Drawing.Drawing2D.GraphicsPath
$bg.AddArc(0, 0, $d, $d, 180, 90); $bg.AddArc($w - $d, 0, $d, $d, 270, 90)
$bg.AddArc($w - $d, $w - $d, $d, $d, 0, 90); $bg.AddArc(0, $w - $d, $d, $d, 90, 90); $bg.CloseFigure()
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point $S, $S), ([System.Drawing.Color]::FromArgb(255, 14, 92, 99)), ([System.Drawing.Color]::FromArgb(255, 49, 46, 129))
$g.FillPath($grad, $bg)

$cx = 64; $cy = 66
# three agent nodes on a triangle around the core
$nodes = @(@(64, 28), @(29, 88), @(99, 88))
$link = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(230, 186, 230, 253)), 7
$link.StartCap = 'Round'; $link.EndCap = 'Round'
foreach ($n in $nodes) { $g.DrawLine($link, $cx, $cy, $n[0], $n[1]) }

$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 240, 249, 255))
$nr = 14
foreach ($n in $nodes) { $g.FillEllipse($white, $n[0] - $nr, $n[1] - $nr, $nr * 2, $nr * 2) }

# shared memory core: bright teal disc with a white ring
$cr = 20
$g.FillEllipse($white, $cx - $cr - 5, $cy - $cr - 5, ($cr + 5) * 2, ($cr + 5) * 2)
$core = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 45, 212, 191))
$g.FillEllipse($core, $cx - $cr, $cy - $cr, $cr * 2, $cr * 2)
$dot = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 30, 58, 138))
$g.FillEllipse($dot, $cx - 7, $cy - 7, 14, 14)

$g.Dispose()
$bmp.Save((Resolve-Path (Split-Path $out)).Path + '\icon.png', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "wrote $out"
