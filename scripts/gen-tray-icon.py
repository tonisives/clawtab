"""Generate a macOS tray icon: claw marks extracted from the app icon.

Extracts the actual claw shapes from the app icon so they match exactly.
For macOS template images: black shapes on transparent background.
macOS uses the alpha channel as a mask and recolors automatically.
"""

from PIL import Image
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
APP_ICON = os.path.join(PROJECT_ROOT, "src-tauri", "icons", "icon.png")


def extract_claws():
    """Extract claw shapes from app icon as a binary mask.

    The app icon is a white canvas with a purple rounded rect containing
    white claw marks. We scan well inside the purple rect to avoid
    picking up the rounded-rect edges or the white background.
    """
    app = Image.open(APP_ICON).convert("RGBA")
    aw, ah = app.size
    px = app.load()

    # Find the purple rounded rect bounds
    purple_min_x, purple_min_y = aw, ah
    purple_max_x, purple_max_y = 0, 0
    for y in range(ah):
        for x in range(aw):
            r, g, b, a = px[x, y]
            if a > 128 and b > 120 and r < 150 and g < 150:
                purple_min_x = min(purple_min_x, x)
                purple_min_y = min(purple_min_y, y)
                purple_max_x = max(purple_max_x, x)
                purple_max_y = max(purple_max_y, y)

    # Generous inset to avoid rounded corner artifacts
    inset = 40
    scan_x1 = purple_min_x + inset
    scan_y1 = purple_min_y + inset
    scan_x2 = purple_max_x - inset
    scan_y2 = purple_max_y - inset

    # Extract white pixels within the purple region (these are the claws)
    mask = Image.new("L", (aw, ah), 0)
    mask_px = mask.load()
    for y in range(scan_y1, scan_y2):
        for x in range(scan_x1, scan_x2):
            r, g, b, a = px[x, y]
            if a > 128 and r > 230 and g > 230 and b > 230:
                mask_px[x, y] = 255

    bbox = mask.getbbox()
    if not bbox:
        raise RuntimeError("Could not find claws in app icon")

    return mask.crop(bbox)


def generate_tray_icon(size=44):
    """Generate tray icon: claw marks as black on transparent."""
    claw_mask = extract_claws()

    # Scale claws to fill the icon
    cw, ch = claw_mask.size
    ratio = min(size / cw, size / ch)
    new_w = int(cw * ratio)
    new_h = int(ch * ratio)
    claw_mask = claw_mask.resize((new_w, new_h), Image.LANCZOS)

    # Create transparent canvas, draw claws as black
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    ox = (size - new_w) // 2
    oy = (size - new_h) // 2

    for y in range(new_h):
        for x in range(new_w):
            if claw_mask.getpixel((x, y)) > 128:
                ix, iy = ox + x, oy + y
                if 0 <= ix < size and 0 <= iy < size:
                    img.putpixel((ix, iy), (0, 0, 0, 255))

    return img


if __name__ == "__main__":
    icon = generate_tray_icon(44)
    icon.save(os.path.join(PROJECT_ROOT, "src-tauri", "icons", "tray-icon.png"))
    print(f"Saved tray-icon.png ({icon.size[0]}x{icon.size[1]})")

    preview = generate_tray_icon(256)
    preview.save("/tmp/tray-icon-preview.png")
    print("Saved preview to /tmp/tray-icon-preview.png")
