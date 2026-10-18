#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PxRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PxSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PxPoint {
    pub x: f64,
    pub y: f64,
}

/// Place the panel just under the tray icon, then clamp it to the work area.
/// Coordinates are in one space (logical points). Y grows downward.
pub fn panel_origin(icon: PxRect, panel: PxSize, work_area: PxRect, gap: f64) -> PxPoint {
    let raw_x = icon.x + (icon.width - panel.width) / 2.0;
    let mut y = icon.y + icon.height + gap;
    let min_x = work_area.x;
    let min_y = work_area.y;
    let max_x = work_area.x + work_area.width - panel.width;
    let max_y = work_area.y + work_area.height - panel.height;

    let x = if max_x >= min_x {
        raw_x.clamp(min_x, max_x)
    } else {
        min_x
    };

    if y < min_y {
        y = min_y;
    }
    if max_y >= min_y && y > max_y {
        let above = icon.y - gap - panel.height;
        y = if above >= min_y { above } else { max_y };
    }

    PxPoint { x, y }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work(x: f64, y: f64, width: f64, height: f64) -> PxRect {
        PxRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn centers_the_panel_under_the_icon() {
        let origin = panel_origin(
            PxRect {
                x: 1000.0,
                y: 0.0,
                width: 24.0,
                height: 24.0,
            },
            PxSize {
                width: 380.0,
                height: 560.0,
            },
            work(0.0, 25.0, 1440.0, 800.0),
            4.0,
        );
        assert_eq!(origin, PxPoint { x: 822.0, y: 28.0 });
    }

    #[test]
    fn clamps_to_the_right_and_left_edges() {
        let panel = PxSize {
            width: 380.0,
            height: 560.0,
        };
        let area = work(0.0, 25.0, 1440.0, 800.0);
        let right = panel_origin(
            PxRect {
                x: 1400.0,
                y: 0.0,
                width: 24.0,
                height: 24.0,
            },
            panel,
            area,
            4.0,
        );
        assert_eq!(right.x, 1060.0);

        let left = panel_origin(
            PxRect {
                x: 0.0,
                y: 0.0,
                width: 24.0,
                height: 24.0,
            },
            panel,
            area,
            4.0,
        );
        assert_eq!(left.x, 0.0);
    }

    #[test]
    fn drops_below_the_menu_bar_when_the_icon_sits_in_it() {
        let origin = panel_origin(
            PxRect {
                x: 800.0,
                y: 0.0,
                width: 22.0,
                height: 22.0,
            },
            PxSize {
                width: 380.0,
                height: 560.0,
            },
            work(0.0, 25.0, 1440.0, 800.0),
            0.0,
        );
        assert_eq!(origin.y, 25.0);
    }

    #[test]
    fn flips_above_the_icon_when_the_work_area_is_too_short() {
        let origin = panel_origin(
            PxRect {
                x: 100.0,
                y: 700.0,
                width: 20.0,
                height: 20.0,
            },
            PxSize {
                width: 380.0,
                height: 200.0,
            },
            work(0.0, 0.0, 800.0, 760.0),
            4.0,
        );
        assert_eq!(origin.y, 496.0);
    }

    #[test]
    fn keeps_the_panel_on_a_monitor_left_of_the_origin() {
        let origin = panel_origin(
            PxRect {
                x: -1000.0,
                y: 0.0,
                width: 24.0,
                height: 24.0,
            },
            PxSize {
                width: 380.0,
                height: 200.0,
            },
            work(-1920.0, 25.0, 1920.0, 1080.0),
            6.0,
        );
        assert_eq!(
            origin,
            PxPoint {
                x: -1178.0,
                y: 30.0
            }
        );
    }
}
