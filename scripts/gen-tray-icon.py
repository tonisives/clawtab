"""Generate a macOS tray icon: circle with claw marks cut out.

For macOS template images: black shapes on transparent background.
macOS uses the alpha channel as a mask and recolors automatically.
The circle is filled black, claw marks are cut out (transparent).

Claw shape matches the app icon: two wider halves joined at a narrow
pinch in the middle, with sharp tips at both ends.
"""

from PIL import Image, ImageDraw
import math


def draw_claw_mark(draw, cx, cy, length, width, angle_deg, pinch=0.7):
    """Draw a single claw mark matching the app icon style.

    The shape has two bulging halves pinched together in the middle,
    creating the characteristic "scratch" look from the app icon.
    pinch: ratio of the narrowest point vs full width (0=closed, 1=diamond)
    """
    angle = math.radians(angle_deg)
    half_len = length / 2
    half_wid = width / 2
    pinch_wid = half_wid * pinch

    dx = math.cos(angle)
    dy = math.sin(angle)
    px = -math.sin(angle)
    py = math.cos(angle)

    # Octagon-ish shape: sharp tips, bulging halves, subtle pinch at center
    # Going clockwise from top tip
    b = 0.55  # bulge position along the length (from center)
    points = [
        # Top tip (sharp point)
        (cx - dx * half_len, cy - dy * half_len),
        # Upper-right bulge
        (cx - dx * half_len * b + px * half_wid,
         cy - dy * half_len * b + py * half_wid),
        # Middle-right pinch
        (cx + px * pinch_wid, cy + py * pinch_wid),
        # Lower-right bulge
        (cx + dx * half_len * b + px * half_wid,
         cy + dy * half_len * b + py * half_wid),
        # Bottom tip (sharp point)
        (cx + dx * half_len, cy + dy * half_len),
        # Lower-left bulge
        (cx + dx * half_len * b - px * half_wid,
         cy + dy * half_len * b - py * half_wid),
        # Middle-left pinch
        (cx - px * pinch_wid, cy - py * pinch_wid),
        # Upper-left bulge
        (cx - dx * half_len * b - px * half_wid,
         cy - dy * half_len * b - py * half_wid),
    ]

    draw.polygon(points, fill=(0, 0, 0, 0))


def generate_tray_icon(size=44):
    """Generate tray icon at given size (44px = 22pt @2x for Retina)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Draw filled circle
    margin = size * 0.04
    draw.ellipse(
        [margin, margin, size - margin - 1, size - margin - 1],
        fill=(0, 0, 0, 255),
    )

    # Three parallel diagonal claw marks, cut out from the circle
    # Angle matches the app icon (~-55 degrees, upper-right to lower-left)
    angle = -55

    center_x = size / 2
    center_y = size / 2

    spacing = size * 0.21

    perp_angle = math.radians(angle + 90)
    offset_x = math.cos(perp_angle) * spacing
    offset_y = math.sin(perp_angle) * spacing

    # Center claw is larger, edge claws are smaller
    marks = [
        (-1, size * 0.5, size * 0.12),
        (0, size * 0.6, size * 0.14),
        (1, size * 0.5, size * 0.12),
    ]

    for i, length, width in marks:
        x = center_x + i * offset_x
        y = center_y + i * offset_y
        draw_claw_mark(draw, x, y, length, width, angle)

    return img


if __name__ == "__main__":
    icon = generate_tray_icon(44)
    icon.save("src-tauri/icons/tray-icon.png")
    print(f"Saved tray-icon.png ({icon.size[0]}x{icon.size[1]})")

    preview = generate_tray_icon(256)
    preview.save("/tmp/tray-icon-preview.png")
    print("Saved preview to /tmp/tray-icon-preview.png")
