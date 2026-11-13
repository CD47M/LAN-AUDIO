Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)

# Rounded background with a green-blue diagonal gradient.
$rect = New-Object System.Drawing.Rectangle(8, 8, 240, 240)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 54
$path.AddArc($rect.X, $rect.Y, $r, $r, 180, 90)
$path.AddArc($rect.Right - $r, $rect.Y, $r, $r, 270, 90)
$path.AddArc($rect.Right - $r, $rect.Bottom - $r, $r, $r, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $r, $r, $r, 90, 90)
$path.CloseFigure()

$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 47, 212, 167),
    [System.Drawing.Color]::FromArgb(255, 72, 168, 255),
    45.0)
$g.FillPath($grad, $path)

# Two phones, slightly rotated, facing each other.
function Draw-Phone($cx, $cy, $w, $h, $angle, $faceColor) {
    $state = $g.Save()
    $g.TranslateTransform($cx, $cy)
    $g.RotateTransform($angle)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $rr = 10
    $x = -$w / 2
    $y = -$h / 2
    $p.AddArc($x, $y, $rr, $rr, 180, 90)
    $p.AddArc($x + $w - $rr, $y, $rr, $rr, 270, 90)
    $p.AddArc($x + $w - $rr, $y + $h - $rr, $rr, $rr, 0, 90)
    $p.AddArc($x, $y + $h - $rr, $rr, $rr, 90, 90)
    $p.CloseFigure()

    $border = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 5, 20, 26), 9)
    $border.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($border, $p)

    $fill = New-Object System.Drawing.SolidBrush($faceColor)
    $g.FillPath($fill, $p)

    # Speaker slit.
    $slit = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(160, 5, 20, 26))
    $g.FillRectangle($slit, [int]($x + $w / 2 - 12), [int]($y + 10), 24, 5)
    $g.FillEllipse($slit, [int]($x + $w / 2 - 8), [int]($y + $h - 24), 16, 16)

    $fill.Dispose(); $border.Dispose(); $slit.Dispose(); $p.Dispose()
    $g.Restore($state)
}

$white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
$soft = [System.Drawing.Color]::FromArgb(255, 234, 250, 246)

Draw-Phone 84 128 78 140 -12 $soft
Draw-Phone 172 128 78 140 12 $white

# Transfer arrows between the phones.
$arrowPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 4, 26, 30), 11)
$arrowPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$arrowPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$arrowPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

# upper arrow (rightwards)
$g.DrawLine($arrowPen, 104, 110, 152, 110)
$g.DrawLines($arrowPen, @(
    (New-Object System.Drawing.PointF(139, 97)),
    (New-Object System.Drawing.PointF(153, 110)),
    (New-Object System.Drawing.PointF(139, 123))
))

# lower arrow (leftwards)
$g.DrawLine($arrowPen, 152, 148, 104, 148)
$g.DrawLines($arrowPen, @(
    (New-Object System.Drawing.PointF(117, 135)),
    (New-Object System.Drawing.PointF(103, 148)),
    (New-Object System.Drawing.PointF(117, 161))
))

$g.Dispose()
$out = 'F:\opencode\audio exchange\tools\sea\appicon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output $out
