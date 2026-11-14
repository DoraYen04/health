// Google Sheets 資料表結構。第一欄一律是該表的唯一 ID。
// 規格書 12 張表 + 3 張系統表（Pending_Action / Audit_Log / System_Log）。

export const SHEETS = {
  Settings: [
    'user_id', 'display_name', 'dashboard_email', 'timezone',
    'reminder_enabled', 'pause_until', 'skip_dates',
    'am_window_start', 'am_window_end', 'pm_window_start', 'pm_window_end',
    'weight_min_kg', 'weight_max_kg', 'weight_jump_alert_kg', 'height_cm',
    'default_medication',
    'calorie_target_kcal', 'protein_target_g', 'fat_target_g', 'carb_target_g',
    'exercise_target_min_week', 'report_ai_enabled',
    'created_at', 'updated_at',
  ],
  Weight_Log: [
    'weight_id', 'user_id', 'measure_date', 'weekday', 'measure_time', 'period',
    'weight_kg', 'source', 'is_backfill', 'status', 'note', 'created_at', 'updated_at',
  ],
  Body_Composition: [
    'body_id', 'user_id', 'measure_date', 'measure_time', 'weight_kg',
    'body_fat_pct', 'body_fat_kg', 'skeletal_muscle_kg', 'visceral_fat', 'bmr_kcal', 'bmi',
    'photo_id', 'ai_confidence', 'verified', 'source', 'status', 'created_at', 'updated_at',
  ],
  Body_Photo: [
    'photo_id', 'user_id', 'photo_date', 'photo_time', 'photo_type',
    'drive_file_id', 'drive_url', 'ai_status', 'ai_raw_json', 'related_record_id',
    'created_at', 'updated_at',
  ],
  Injection_Log: [
    'injection_id', 'user_id', 'injection_date', 'injection_time', 'medication',
    'dosage_mg', 'status', 'note', 'created_at', 'updated_at',
  ],
  Task_Schedule: [
    'task_id', 'user_id', 'task_name', 'task_type', 'frequency', 'weekday', 'day_of_month',
    'remind_time', 'repeat_enabled', 'repeat_minutes', 'overdue_minutes',
    'required_input', 'message', 'enabled', 'created_at', 'updated_at',
  ],
  Reminder_Log: [
    'reminder_id', 'event_id', 'user_id', 'task_id', 'occurrence_date',
    'scheduled_at', 'sent_at', 'reminder_type', 'status', 'completed_at',
    'retry_count', 'last_error', 'last_error_at',
  ],
  Meal_Log: [
    'meal_id', 'user_id', 'meal_date', 'meal_time', 'meal_type', 'food_name', 'quantity',
    'photo_id', 'photo_url', 'calorie_kcal', 'protein_g', 'fat_g', 'carb_g',
    'nutrition_source', 'verified', 'status', 'created_at', 'updated_at',
  ],
  Nutrition_Log: [
    'nutrition_id', 'meal_id', 'user_id', 'nutrient_type', 'value', 'unit',
    'source', 'verified', 'created_at',
  ],
  Exercise_Log: [
    'exercise_id', 'user_id', 'exercise_date', 'exercise_time', 'exercise_type',
    'duration_min', 'distance_km', 'intensity', 'calories_burned', 'calories_source',
    'note', 'status', 'created_at', 'updated_at',
  ],
  Goal_Log: [
    'goal_id', 'user_id', 'goal_type', 'start_value', 'target_value',
    'start_date', 'target_date', 'current_value', 'status', 'note', 'created_at', 'updated_at',
  ],
  Report_Log: [
    'report_id', 'user_id', 'report_type', 'start_date', 'end_date',
    'comparison_json', 'ai_summary', 'generated_at', 'delivery_status',
    'delivered_at', 'retry_count', 'last_error',
  ],
  Pending_Action: [
    'pending_id', 'user_id', 'action_type', 'payload_json', 'status',
    'created_at', 'expires_at', 'resolved_at',
  ],
  Audit_Log: [
    'audit_id', 'user_id', 'sheet', 'record_id', 'field',
    'before_value', 'after_value', 'changed_by', 'changed_at',
  ],
  System_Log: [
    'log_id', 'level', 'source', 'message', 'detail', 'created_at',
  ],
};

export const ID_FIELD = Object.fromEntries(
  Object.entries(SHEETS).map(([name, cols]) => [name, cols[0]]),
);

// 狀態值（中文，直接顯示於 Sheets 方便人工檢視）
export const STATUS = {
  NORMAL: '正常',
  CORRECTED: '已修正',
  DELETED: '已刪除',
};

export const REMINDER_STATUS = {
  PENDING: '待發送',
  SENT: '已發送',
  DONE: '已完成',
  OVERDUE: '逾期',
  FAILED: '失敗',
  SKIPPED: '略過',
};

export const DEFAULT_SETTINGS = {
  timezone: 'Asia/Taipei',
  reminder_enabled: true,
  pause_until: '',
  skip_dates: '',
  am_window_start: '04:00',
  am_window_end: '11:59',
  pm_window_start: '12:00',
  pm_window_end: '20:59',
  weight_min_kg: 30,
  weight_max_kg: 200,
  weight_jump_alert_kg: 2.5,
  height_cm: '',
  default_medication: '',
  calorie_target_kcal: '',
  protein_target_g: '',
  fat_target_g: '',
  carb_target_g: '',
  exercise_target_min_week: 150,
  report_ai_enabled: true,
};

// 新使用者預設作業排程（皆可於 Dashboard 修改／啟用／停用）
// 預設只提醒：上午體重、下午體重、每週施打，各提醒一次、不補提醒。
// 體脂測量與日／週／月報告預設停用（LINE 輸入「今日報告」等仍可隨時查詢）。
export const DEFAULT_TASKS = [
  { task_name: '上午體重', task_type: 'weight_am', frequency: '每日', remind_time: '08:00', repeat_enabled: false, repeat_minutes: 0, overdue_minutes: 180, required_input: '數值', message: '早安！今天記得測量體重喔！請輸入目前體重（kg），例如 59.8。' },
  { task_name: '下午體重', task_type: 'weight_pm', frequency: '每日', remind_time: '14:00', repeat_enabled: false, repeat_minutes: 0, overdue_minutes: 180, required_input: '數值', message: '請測量並輸入下午體重（kg）。' },
  { task_name: '施打紀錄', task_type: 'injection', frequency: '每週', weekday: 1, remind_time: '20:00', repeat_enabled: false, repeat_minutes: 0, overdue_minutes: 240, required_input: '劑量', message: '本週固定作業提醒：請依醫囑確認是否為施打日。若已施打，請輸入「施打 劑量」，例如：施打 2.5mg。' },
  { task_name: '每日報告', task_type: 'daily_report', frequency: '每日', remind_time: '21:00', repeat_enabled: false, repeat_minutes: 0, overdue_minutes: 0, required_input: '', message: '', enabled: false },
  { task_name: '體脂測量', task_type: 'body_composition', frequency: '每週', weekday: 0, remind_time: '09:00', repeat_enabled: false, repeat_minutes: 0, overdue_minutes: 600, required_input: '照片', message: '今天是體脂測量日，請上傳體脂計測量照片。', enabled: false },
  { task_name: '每週報告', task_type: 'weekly_report', frequency: '每週', weekday: 0, remind_time: '20:00', repeat_enabled: false, repeat_minutes: 0, overdue_minutes: 0, required_input: '', message: '', enabled: false },
  { task_name: '每月報告', task_type: 'monthly_report', frequency: '每月', day_of_month: 'last', remind_time: '20:00', repeat_enabled: false, repeat_minutes: 0, overdue_minutes: 0, required_input: '', message: '', enabled: false },
];

export const TASK_TYPES = {
  weight_am: '上午體重',
  weight_pm: '下午體重',
  body_composition: '體脂測量',
  injection: '施打紀錄',
  meal: '飲食紀錄',
  exercise: '運動紀錄',
  daily_report: '每日報告',
  weekly_report: '每週報告',
  monthly_report: '每月報告',
  custom: '自訂提醒',
};
