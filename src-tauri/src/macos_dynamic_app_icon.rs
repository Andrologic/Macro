use crate::MacosAppIconThemeSpec;
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_app_kit::{
    NSApplication, NSBezierPath, NSBitmapImageRep, NSCalibratedRGBColorSpace, NSColor,
    NSCompositingOperation, NSGraphicsContext, NSImage, NSImageInterpolation,
};
use objc2_foundation::{MainThreadMarker, NSData, NSPoint, NSRect, NSSize};

const LOGO_SVG_TEMPLATE: &str = include_str!("../../public/logo.svg");
const DEFAULT_LOGO_START_COLOR: &str = "#3B82F6";
const DEFAULT_LOGO_END_COLOR: &str = "#1E40AF";

const ICON_CANVAS_SIZE: usize = 1024;
const ICON_BACKGROUND_INSET: f64 = 48.0;
const ICON_BACKGROUND_SIZE: f64 = 928.0;
const ICON_BACKGROUND_RADIUS: f64 = 232.0;
const ICON_LOGO_FRAME_X: f64 = 184.0;
const ICON_LOGO_FRAME_Y: f64 = 184.0;
const ICON_LOGO_FRAME_SIZE: f64 = 656.0;
const ALPHA_THRESHOLD: u8 = 3;

#[derive(Clone, Copy, Debug, PartialEq)]
struct PixelRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl PixelRect {
    const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    fn mid_x(self) -> f64 {
        self.x + self.width / 2.0
    }

    fn mid_y(self) -> f64 {
        self.y + self.height / 2.0
    }
}

pub fn set_application_icon_for_theme(spec: &MacosAppIconThemeSpec) -> Result<(), String> {
    let app_icon = render_ns_image(spec)?;
    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    let app = NSApplication::sharedApplication(mtm);

    unsafe { app.setApplicationIconImage(Some(&app_icon)) };
    Ok(())
}

fn render_ns_image(spec: &MacosAppIconThemeSpec) -> Result<Retained<NSImage>, String> {
    let bitmap = render_icon_bitmap(spec)?;
    let image = NSImage::initWithSize(
        NSImage::alloc(),
        NSSize::new(ICON_CANVAS_SIZE as f64, ICON_CANVAS_SIZE as f64),
    );
    image.addRepresentation(&bitmap);
    Ok(image)
}

fn render_icon_bitmap(spec: &MacosAppIconThemeSpec) -> Result<Retained<NSBitmapImageRep>, String> {
    let source_image = build_themed_logo_image(spec)?;
    let source_bitmap = rasterize_logo_source(&source_image)?;
    let visible_bounds = alpha_bounds(&source_bitmap)
        .ok_or_else(|| "Logo rasterization produced no visible pixels".to_string())?;
    let draw_rect = compute_logo_draw_rect(
        visible_bounds,
        ICON_CANVAS_SIZE as f64,
        ICON_CANVAS_SIZE as f64,
    );
    let background_color = parse_hex_color(&spec.background_color)?;
    let final_bitmap = create_bitmap_rep()?;

    draw_into_bitmap(&final_bitmap, |context| {
        let _ = context;
        background_color.setFill();
        let background = NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(
            ns_rect(background_rect()),
            ICON_BACKGROUND_RADIUS,
            ICON_BACKGROUND_RADIUS,
        );
        background.fill();

        source_image.drawInRect_fromRect_operation_fraction(
            ns_rect(draw_rect),
            zero_rect(),
            NSCompositingOperation::SourceOver,
            1.0,
        );

        Ok(())
    })?;

    Ok(final_bitmap)
}

fn build_themed_logo_image(spec: &MacosAppIconThemeSpec) -> Result<Retained<NSImage>, String> {
    let themed_svg = LOGO_SVG_TEMPLATE
        .replace(DEFAULT_LOGO_START_COLOR, &spec.logo_start_color)
        .replace(DEFAULT_LOGO_END_COLOR, &spec.logo_end_color)
        .replace(
            &DEFAULT_LOGO_START_COLOR.to_ascii_lowercase(),
            &spec.logo_start_color,
        )
        .replace(
            &DEFAULT_LOGO_END_COLOR.to_ascii_lowercase(),
            &spec.logo_end_color,
        );
    let svg_data = NSData::with_bytes(themed_svg.as_bytes());
    let image = NSImage::initWithData(NSImage::alloc(), &svg_data)
        .ok_or_else(|| "Failed to decode themed logo SVG on macOS".to_string())?;

    image.setTemplate(false);
    Ok(image)
}

fn rasterize_logo_source(source_image: &NSImage) -> Result<Retained<NSBitmapImageRep>, String> {
    let source_bitmap = create_bitmap_rep()?;

    draw_into_bitmap(&source_bitmap, |context| {
        let _ = context;
        source_image.drawInRect_fromRect_operation_fraction(
            ns_rect(PixelRect::new(
                0.0,
                0.0,
                ICON_CANVAS_SIZE as f64,
                ICON_CANVAS_SIZE as f64,
            )),
            zero_rect(),
            NSCompositingOperation::SourceOver,
            1.0,
        );

        Ok(())
    })?;

    Ok(source_bitmap)
}

fn create_bitmap_rep() -> Result<Retained<NSBitmapImageRep>, String> {
    let bitmap = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            ICON_CANVAS_SIZE as isize,
            ICON_CANVAS_SIZE as isize,
            8,
            4,
            true,
            false,
            NSCalibratedRGBColorSpace,
            0,
            0,
        )
    }
    .ok_or_else(|| "Failed to allocate macOS app icon bitmap".to_string())?;
    let bitmap_data = bitmap.bitmapData();

    if bitmap_data.is_null() {
        return Err("Failed to access macOS app icon bitmap data".to_string());
    }

    unsafe {
        std::ptr::write_bytes(
            bitmap_data,
            0,
            bitmap.bytesPerRow() as usize * ICON_CANVAS_SIZE,
        );
    }

    Ok(bitmap)
}

fn draw_into_bitmap<T, F>(bitmap: &NSBitmapImageRep, draw: F) -> Result<T, String>
where
    F: FnOnce(&NSGraphicsContext) -> Result<T, String>,
{
    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(bitmap)
        .ok_or_else(|| "Failed to create macOS bitmap graphics context".to_string())?;

    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&context));
    context.setShouldAntialias(true);
    context.setImageInterpolation(NSImageInterpolation::High);

    let result = draw(&context);
    context.flushGraphics();
    NSGraphicsContext::restoreGraphicsState_class();

    result
}

fn alpha_bounds(bitmap: &NSBitmapImageRep) -> Option<PixelRect> {
    let width = bitmap.pixelsWide() as usize;
    let height = bitmap.pixelsHigh() as usize;
    let bytes_per_row = bitmap.bytesPerRow() as usize;
    let samples_per_pixel = bitmap.samplesPerPixel() as usize;
    let bitmap_data = bitmap.bitmapData();

    if bitmap_data.is_null() || samples_per_pixel < 4 {
        return None;
    }

    let bitmap_slice = unsafe { std::slice::from_raw_parts(bitmap_data, bytes_per_row * height) };
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0usize;
    let mut max_y = 0usize;
    let mut found_visible_pixel = false;

    for y in 0..height {
        for x in 0..width {
            let alpha_index = y * bytes_per_row + x * samples_per_pixel + (samples_per_pixel - 1);
            if bitmap_slice[alpha_index] >= ALPHA_THRESHOLD {
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
                found_visible_pixel = true;
            }
        }
    }

    if !found_visible_pixel {
        return None;
    }

    Some(PixelRect::new(
        min_x as f64,
        min_y as f64,
        (max_x - min_x + 1) as f64,
        (max_y - min_y + 1) as f64,
    ))
}

fn compute_logo_draw_rect(
    visible_bounds: PixelRect,
    source_width: f64,
    source_height: f64,
) -> PixelRect {
    let logo_frame = logo_frame_rect();
    let scale =
        (logo_frame.width / visible_bounds.width).min(logo_frame.height / visible_bounds.height);
    let draw_width = source_width * scale;
    let draw_height = source_height * scale;
    let source_center_x = source_width / 2.0;
    let source_center_y = source_height / 2.0;
    let centering_offset_x = (source_center_x - visible_bounds.mid_x()) * scale;
    let centering_offset_y = (source_center_y - visible_bounds.mid_y()) * scale;

    PixelRect::new(
        logo_frame.x + (logo_frame.width - draw_width) / 2.0 + centering_offset_x,
        logo_frame.y + (logo_frame.height - draw_height) / 2.0 + centering_offset_y,
        draw_width,
        draw_height,
    )
}

fn background_rect() -> PixelRect {
    PixelRect::new(
        ICON_BACKGROUND_INSET,
        ICON_BACKGROUND_INSET,
        ICON_BACKGROUND_SIZE,
        ICON_BACKGROUND_SIZE,
    )
}

fn logo_frame_rect() -> PixelRect {
    PixelRect::new(
        ICON_LOGO_FRAME_X,
        ICON_LOGO_FRAME_Y,
        ICON_LOGO_FRAME_SIZE,
        ICON_LOGO_FRAME_SIZE,
    )
}

fn ns_rect(rect: PixelRect) -> NSRect {
    NSRect::new(
        NSPoint::new(rect.x, rect.y),
        NSSize::new(rect.width, rect.height),
    )
}

fn zero_rect() -> NSRect {
    NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0))
}

fn parse_hex_color(hex: &str) -> Result<Retained<NSColor>, String> {
    let sanitized = hex.trim().trim_start_matches('#');
    let expanded = match sanitized.len() {
        3 => sanitized
            .chars()
            .flat_map(|value| [value, value])
            .collect::<String>(),
        6 => sanitized.to_string(),
        _ => {
            return Err(format!(
                "Unsupported macOS app icon color format: {hex}. Expected #RGB or #RRGGBB."
            ))
        }
    };

    let red = u8::from_str_radix(&expanded[0..2], 16)
        .map_err(|_| format!("Invalid red channel in color {hex}"))?;
    let green = u8::from_str_radix(&expanded[2..4], 16)
        .map_err(|_| format!("Invalid green channel in color {hex}"))?;
    let blue = u8::from_str_radix(&expanded[4..6], 16)
        .map_err(|_| format!("Invalid blue channel in color {hex}"))?;

    Ok(NSColor::colorWithSRGBRed_green_blue_alpha(
        f64::from(red) / 255.0,
        f64::from(green) / 255.0,
        f64::from(blue) / 255.0,
        1.0,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_rect_matches_octan_template() {
        assert_eq!(background_rect(), PixelRect::new(48.0, 48.0, 928.0, 928.0));
    }

    #[test]
    fn logo_frame_matches_octan_template() {
        assert_eq!(
            logo_frame_rect(),
            PixelRect::new(184.0, 184.0, 656.0, 656.0)
        );
    }

    #[test]
    fn logo_draw_rect_fits_visible_bounds_inside_octan_frame() {
        let visible_bounds = PixelRect::new(192.0, 138.0, 640.0, 676.0);
        let draw_rect = compute_logo_draw_rect(visible_bounds, 1024.0, 1024.0);
        let scale = draw_rect.width / 1024.0;
        let scaled_visible_width = visible_bounds.width * scale;
        let scaled_visible_height = visible_bounds.height * scale;
        let visible_center_x = draw_rect.x + visible_bounds.mid_x() * scale;
        let visible_center_y = draw_rect.y + visible_bounds.mid_y() * scale;
        let frame = logo_frame_rect();

        assert!(scaled_visible_width <= ICON_LOGO_FRAME_SIZE + f64::EPSILON);
        assert!(scaled_visible_height <= ICON_LOGO_FRAME_SIZE + f64::EPSILON);
        assert!((visible_center_x - frame.mid_x()).abs() < 0.01);
        assert!((visible_center_y - frame.mid_y()).abs() < 0.01);
    }
}
