use objc2::rc::Retained;
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
use objc2_foundation::MainThreadMarker;
use std::ptr;

#[derive(Clone, Debug, Eq, PartialEq)]
struct MenuItemSignature {
    title: String,
    key_equivalent: String,
    has_submenu: bool,
    is_separator: bool,
}

struct CandidateMenuMatch {
    menu: Retained<NSMenu>,
    exact_match: bool,
    overlap: usize,
    top_level_title: String,
}

impl CandidateMenuMatch {
    fn is_named_window(&self) -> bool {
        self.top_level_title.eq_ignore_ascii_case("Window")
    }

    fn is_better_than(&self, other: &Self) -> bool {
        (self.exact_match, self.overlap, self.is_named_window())
            > (other.exact_match, other.overlap, other.is_named_window())
    }
}

pub fn rebind_visible_windows_menu() -> Result<(), String> {
    // muda can leave NSApp.windowsMenu pointing at a detached model menu instead
    // of the visible "Window" submenu, so AppKit injects native tiling entries
    // into the wrong NSMenu. Rebind to the visible submenu best-effort.
    let mtm = unsafe { MainThreadMarker::new_unchecked() };
    let app = NSApplication::sharedApplication(mtm);
    let Some(model_windows_menu) = app.windowsMenu() else {
        return Err("NSApp.windowsMenu is not available".to_string());
    };
    let Some(main_menu) = app.mainMenu() else {
        return Err("NSApp.mainMenu is not available".to_string());
    };

    let reference_signature = menu_signature(&model_windows_menu);
    if reference_signature.is_empty() {
        return Err("NSApp.windowsMenu has no items to match against".to_string());
    }

    let mut best_match: Option<CandidateMenuMatch> = None;

    for top_level_item in main_menu.itemArray().iter() {
        let Some(candidate_menu) = top_level_item.submenu() else {
            continue;
        };

        if ptr::eq(&*candidate_menu, &*model_windows_menu) {
            tracing::debug!("macOS Window menu already points at the visible submenu");
            return Ok(());
        }

        let candidate_signature = menu_signature(&candidate_menu);
        if candidate_signature.is_empty() {
            continue;
        }

        let exact_match = candidate_signature == reference_signature;
        let overlap = signature_overlap(&reference_signature, &candidate_signature);
        if !exact_match && overlap == 0 {
            continue;
        }

        let candidate = CandidateMenuMatch {
            menu: candidate_menu,
            exact_match,
            overlap,
            top_level_title: top_level_item.title().to_string(),
        };

        match &best_match {
            Some(current) if !candidate.is_better_than(current) => {}
            _ => best_match = Some(candidate),
        }
    }

    let Some(best_match) = best_match else {
        return Err("Could not find a visible Window submenu in NSApp.mainMenu".to_string());
    };

    app.setWindowsMenu(Some(&best_match.menu));
    tracing::info!(
        exact_match = best_match.exact_match,
        overlap = best_match.overlap,
        top_level_title = best_match.top_level_title.as_str(),
        "Rebound NSApp.windowsMenu to the visible macOS Window submenu"
    );

    Ok(())
}

fn menu_signature(menu: &NSMenu) -> Vec<MenuItemSignature> {
    menu.itemArray()
        .iter()
        .map(|item| menu_item_signature(&item))
        .collect()
}

fn menu_item_signature(item: &NSMenuItem) -> MenuItemSignature {
    MenuItemSignature {
        title: item.title().to_string(),
        key_equivalent: item.keyEquivalent().to_string(),
        has_submenu: item.hasSubmenu(),
        is_separator: item.isSeparatorItem(),
    }
}

fn signature_overlap(lhs: &[MenuItemSignature], rhs: &[MenuItemSignature]) -> usize {
    ordered_signature_overlap(lhs, rhs).max(ordered_signature_overlap(rhs, lhs))
}

fn ordered_signature_overlap(
    reference: &[MenuItemSignature],
    candidate: &[MenuItemSignature],
) -> usize {
    let mut reference_index = 0;
    let mut matched_items = 0;

    for candidate_item in candidate {
        while reference_index < reference.len() {
            if reference[reference_index] == *candidate_item {
                matched_items += 1;
                reference_index += 1;
                break;
            }
            reference_index += 1;
        }
    }

    matched_items
}
