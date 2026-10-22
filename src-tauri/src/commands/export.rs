use rust_xlsxwriter::{Format, Workbook, XlsxError};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// Excel's hard limit on the number of characters stored in a single cell.
const MAX_CELL_CHARS: usize = 32_767;

fn xlsx_err(error: XlsxError) -> AppError {
    AppError::Config(format!("excel: {error}"))
}

/// Native "Save As" dialog. Returns None when the user cancels.
async fn save_file_dialog(default_name: String) -> AppResult<Option<String>> {
    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
             Add-Type -AssemblyName System.Windows.Forms | Out-Null; \
             $dialog = New-Object System.Windows.Forms.SaveFileDialog; \
             $dialog.Filter = 'Excel workbook (*.xlsx)|*.xlsx|All files (*.*)|*.*'; \
             $dialog.FileName = '{}'; \
             if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ \
               [Console]::Out.Write($dialog.FileName) \
             }}",
            default_name.replace('\'', "''")
        );
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-STA", "-Command", &script])
                .output()
        })
        .await
        .map_err(|error| AppError::Config(format!("save dialog: {error}")))?
        .map_err(|error| AppError::Config(format!("save dialog: {error}")))?;

        if !output.status.success() {
            return Err(AppError::Config(format!(
                "save dialog: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if path.is_empty() { None } else { Some(path) })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = default_name;
        Err(AppError::Config(
            "the Excel save dialog is only implemented on Windows".into(),
        ))
    }
}

fn write_xlsx(path: &str, columns: &[String], rows: &[Vec<Value>]) -> AppResult<()> {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    let header = Format::new().set_bold();

    for (col, name) in columns.iter().enumerate() {
        sheet
            .write_with_format(0, col as u16, name.as_str(), &header)
            .map_err(xlsx_err)?;
    }

    for (row_index, row) in rows.iter().enumerate() {
        let r = (row_index + 1) as u32;
        for (col, value) in row.iter().enumerate() {
            let c = col as u16;
            match value {
                Value::Null => {}
                Value::Bool(b) => {
                    sheet.write_boolean(r, c, *b).map_err(xlsx_err)?;
                }
                Value::Number(n) => {
                    if let Some(f) = n.as_f64() {
                        sheet.write_number(r, c, f).map_err(xlsx_err)?;
                    } else {
                        sheet
                            .write_string(r, c, n.to_string().as_str())
                            .map_err(xlsx_err)?;
                    }
                }
                Value::String(s) => {
                    sheet.write_string(r, c, clamp(s)).map_err(xlsx_err)?;
                }
                other => {
                    sheet
                        .write_string(r, c, clamp(&other.to_string()))
                        .map_err(xlsx_err)?;
                }
            }
        }
    }

    sheet.autofit();
    workbook.save(path).map_err(xlsx_err)?;
    Ok(())
}

/// Truncate to Excel's per-cell character limit.
fn clamp(text: &str) -> String {
    if text.chars().count() > MAX_CELL_CHARS {
        text.chars().take(MAX_CELL_CHARS).collect()
    } else {
        text.to_string()
    }
}

/// Export an already-fetched result set to an .xlsx file chosen by the user.
/// Returns the saved path, or None if the save dialog was cancelled.
#[tauri::command(rename_all = "snake_case")]
pub async fn export_result_xlsx(
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    default_name: String,
) -> AppResult<Option<String>> {
    if columns.is_empty() {
        return Err(AppError::Config("nothing to export".into()));
    }
    let path = match save_file_dialog(default_name).await? {
        Some(path) => path,
        None => return Ok(None),
    };
    let path = if path.to_ascii_lowercase().ends_with(".xlsx") {
        path
    } else {
        format!("{path}.xlsx")
    };

    tokio::task::spawn_blocking(move || write_xlsx(&path, &columns, &rows).map(|_| path))
        .await
        .map_err(|error| AppError::Config(format!("excel: {error}")))?
        .map(Some)
}
