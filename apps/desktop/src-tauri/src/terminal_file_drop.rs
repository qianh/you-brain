use std::cell::RefCell;
use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, ProtocolObject, Sel};
use objc2::{ffi, msg_send, sel};
use objc2_app_kit::{NSDraggingInfo, NSPasteboardTypeFileURL, NSView};
use tauri::{Manager, WebviewWindow};
use url::Url;

thread_local! {
    static MAIN: RefCell<Option<(usize, WebviewWindow)>> = const { RefCell::new(None) };
}

type PerformDrop = extern "C-unwind" fn(&AnyObject, Sel, &ProtocolObject<dyn NSDraggingInfo>) -> Bool;

// 原来的 performDragOperation: 实现。
static ORIGINAL_DROP: OnceLock<PerformDrop> = OnceLock::new();

// 不能用 object_setClass 把 WebView 换成运行时子类：macOS 26 上外部程序经辅助功能缩放窗口时，
// WKWebView 重算圆角会在 AppKit 断言里 abort。这里只在 WebView 原本的类上替换方法实现，对象的类保持不变。
pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    let window_handle = window.clone();
    window.with_webview(move |webview| {
        let pointer = webview.inner().cast::<AnyObject>();
        let Some(view) = (unsafe { pointer.as_ref() }) else {
            return;
        };
        if ORIGINAL_DROP.get().is_none() {
            // 用 -class 而不是 isa：对象可能已被 KVO 换成 NSKVONotifying_ 子类。
            let class: &AnyClass = unsafe { msg_send![view, class] };
            let selector = sel!(performDragOperation:);
            let Some(method) = class.instance_method(selector) else {
                return;
            };
            let original: PerformDrop = unsafe { std::mem::transmute(method.implementation()) };
            let _ = ORIGINAL_DROP.set(original);
            let replacement: Imp = unsafe { std::mem::transmute(perform_drop as PerformDrop) };
            unsafe {
                ffi::class_replaceMethod(
                    class as *const AnyClass as *mut AnyClass,
                    selector,
                    replacement,
                    ffi::method_getTypeEncoding(method),
                );
            }
        }
        MAIN.with_borrow_mut(|main| *main = Some((pointer as usize, window_handle)));
    })
}

extern "C-unwind" fn perform_drop(
    receiver: &AnyObject,
    _selector: Sel,
    drag: &ProtocolObject<dyn NSDraggingInfo>,
) -> Bool {
    let window = MAIN.with_borrow(|main| {
        main.as_ref()
            .filter(|(pointer, _)| *pointer == receiver as *const AnyObject as usize)
            .map(|(_, window)| window.clone())
    });
    if let Some(window) = window {
        let view = unsafe { &*(receiver as *const AnyObject).cast::<NSView>() };
        deliver_paths(&window, view, drag);
    }

    match ORIGINAL_DROP.get() {
        Some(original) => original(receiver, sel!(performDragOperation:), drag),
        None => Bool::NO,
    }
}

fn deliver_paths(window: &WebviewWindow, view: &NSView, drag: &ProtocolObject<dyn NSDraggingInfo>) {
    let Some(endpoint) = super::current_endpoint(window.app_handle()) else {
        return;
    };
    let origin = format!("http://127.0.0.1:{}", endpoint.port);
    let paths: Vec<String> = drag
        .draggingPasteboard()
        .pasteboardItems()
        .iter()
        .flat_map(|items| items.iter())
        .filter_map(|item| item.stringForType(unsafe { NSPasteboardTypeFileURL }))
        .filter_map(|value| local_file_path(&value.to_string()))
        .collect();
    if paths.is_empty() {
        return;
    }

    let bounds = view.bounds();
    let point = view.convertPoint_fromView(drag.draggingLocation(), None);
    let x = (point.x - bounds.origin.x) / bounds.size.width;
    let relative_y = (point.y - bounds.origin.y) / bounds.size.height;
    let y = if view.isFlipped() {
        relative_y
    } else {
        1.0 - relative_y
    };
    if !(0.0..1.0).contains(&x) || !(0.0..1.0).contains(&y) {
        return;
    }
    let Ok(payload) = serde_json::to_string(&paths) else {
        return;
    };
    let _ = window.eval(format!(
        "if (location.origin === '{origin}' && location.pathname === '/deck') {{\
            document.elementFromPoint(innerWidth * {x}, innerHeight * {y})?.closest('.deck-tty7-xterm')\
            ?.dispatchEvent(new CustomEvent('you-brain:terminal-file-drop', {{detail: {payload}}}));\
        }}"
    ));
}

fn local_file_path(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    url.to_file_path().ok()?.into_os_string().into_string().ok()
}

#[cfg(test)]
mod tests {
    use super::local_file_path;

    #[test]
    fn resolves_local_file_urls_without_reading_or_copying_the_files() {
        assert_eq!(
            local_file_path("file:///tmp/My%20File.pdf").as_deref(),
            Some("/tmp/My File.pdf")
        );
        assert_eq!(local_file_path("https://localhost/tmp/a"), None);
        assert_eq!(local_file_path("file://server/tmp/a"), None);
    }
}
