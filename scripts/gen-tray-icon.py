"""Generate a macOS tray icon: circle with claw marks cut out.

For macOS template images: black shapes on transparent background.
macOS uses the alpha channel as a mask and recolors automatically.
The circle is filled black, claw marks are cut out (transparent).
"""

from PIL import Image, ImageDraw
import math


def draw_claw_mark(draw, cx, cy, length, width, angle_deg, size):
    """Draw a single claw mark (elongated diamond/slash shape).

    Draws in transparent (erasing) to cut out from the circle.
    """
    angle = math.radians(angle_deg)
    half_len = length / 2
    half_wid = width / 2

    # Direction along the slash
    dx = math.cos(angle)
    dy = math.sin(angle)

    # Perpendicular direction
    px = -math.sin(angle)
    py = math.cos(angle)

    # Create diamond shape: pointed at ends, wide in middle
    points = [
        (cx - dx * half_len, cy - dy * half_len),
        (cx + px * half_wid, cy + py * half_wid),
        (cx + dx * half_len, cy + dy * half_len),
        (cx - px * half_wid, cy - py * half_wid),
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
    angle = -60
    mark_length = size * 0.6
    mark_width = size * 0.14
    spacing = size * 0.2

    center_x = size / 2
    center_y = size / 2

    perp_angle = math.radians(angle + 90)
    offset_x = math.cos(perp_angle) * spacing
    offset_y = math.sin(perp_angle) * spacing

    for i in range(-1, 2):
        x = center_x + i * offset_x
        y = center_y + i * offset_y
        draw_claw_mark(draw, x, y, mark_length, mark_width, angle, size)

    return img


if __name__ == "__main__":
    icon = generate_tray_icon(44)
    icon.save("src-tauri/icons/tray-icon.png")
    print(f"Saved tray-icon.png ({icon.size[0]}x{icon.size[1]})")

    preview = generate_tray_icon(256)
    preview.save("/tmp/tray-icon-preview.png")
    print("Saved preview to /tmp/tray-icon-preview.png")
