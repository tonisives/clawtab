"""Generate a macOS tray icon with claw marks matching the app icon design.

For macOS template images: black shapes on transparent background.
macOS uses the alpha channel as a mask and recolors automatically.
"""

from PIL import Image, ImageDraw
import math


def draw_claw_mark(draw, cx, cy, length, width, angle_deg, size):
    """Draw a single claw mark (elongated diamond/slash shape).

    The claw marks in the app icon are diagonal slashes that are wider
    in the middle and taper to points at both ends.
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
        # Top point (sharp)
        (cx - dx * half_len, cy - dy * half_len),
        # Right middle (wide)
        (cx + px * half_wid, cy + py * half_wid),
        # Bottom point (sharp)
        (cx + dx * half_len, cy + dy * half_len),
        # Left middle (wide)
        (cx - px * half_wid, cy - py * half_wid),
    ]

    draw.polygon(points, fill=(0, 0, 0, 255))


def generate_tray_icon(size=44):
    """Generate tray icon at given size (44px = 22pt @2x for Retina)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Three parallel diagonal claw marks, going from upper-left to lower-right
    # Matching the ~45 degree angle from the app icon
    angle = -60  # degrees, matching the app icon slash direction

    # Scale proportions relative to icon size
    mark_length = size * 0.55
    mark_width = size * 0.08
    spacing = size * 0.18

    # Center of the icon
    center_x = size / 2
    center_y = size / 2

    # Perpendicular offset direction for spacing the three marks
    perp_angle = math.radians(angle + 90)
    offset_x = math.cos(perp_angle) * spacing
    offset_y = math.sin(perp_angle) * spacing

    # Draw three claw marks
    for i in range(-1, 2):
        x = center_x + i * offset_x
        y = center_y + i * offset_y
        draw_claw_mark(draw, x, y, mark_length, mark_width, angle, size)

    return img


if __name__ == "__main__":
    # Generate at 44x44 (22pt @2x for macOS Retina tray)
    icon = generate_tray_icon(44)
    icon.save("src-tauri/icons/tray-icon.png")
    print(f"Saved tray-icon.png ({icon.size[0]}x{icon.size[1]})")

    # Also save a larger preview version
    preview = generate_tray_icon(256)
    preview.save("/tmp/tray-icon-preview.png")
    print("Saved preview to /tmp/tray-icon-preview.png")
