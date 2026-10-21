// 画面とメインプロセスの間の窓口。**これ以外の経路は開けない**（contextIsolation: true）。
// 画面側は Node にも音源にもネットワークにも触れない。solver を呼ぶことしかできない。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dj', {
  /** solver を呼ぶ。argv は CLI と同じフラグ（例: ['--venue','edm','--minutes','30']） */
  solve: (argv) => ipcRenderer.invoke('solve', argv),
  /** 曲を探す。第 1 引数が検索語、以降は今のオーダーのフラグ（使えるかの判定に要る） */
  find: (argv) => ipcRenderer.invoke('find', argv),
  /** その音源をこの機械で鳴らせるか（Mac には音源が無い） */
  audioOk: (path) => ipcRenderer.invoke('audio-ok', path),
  /**
   * セットリストを名前を付けて書き出す（保存ダイアログを出す）。
   * `{ filePath, suggested }`。**`suggested` の拡張子が形式の正本**
   * （`.m3u8` = 普通の書き出し / `.xml` = Ｑ付き）。
   */
  exportSet: (arg) => ipcRenderer.invoke('export', arg),
  /**
   * メモリーＱを打った XML を作る（**ボタンを押したときだけ**。普通の書き出しは Ｑを書かない）。
   * 音源を全長デコードするので 1 曲 0.3 秒かかる。画面側で待つ表示を出すこと。
   */
  cueExport: (arg) => ipcRenderer.invoke('cue-export', arg),
  /** 書き出したファイルを Finder / エクスプローラで開く */
  reveal: (filePath) => ipcRenderer.invoke('reveal', filePath),

  // --- 曲を追加する（rekordbox の XML を読み込んで、増えた曲だけ解析する） ---
  /** XML を選ばせる。選ばれたパスを返す（キャンセルなら null） */
  pickXml: () => ipcRenderer.invoke('pick-xml'),
  /** いま DB に何曲あるか。読み込み前後の比較に使う */
  dbCount: () => ipcRenderer.invoke('db-count'),
  dbReady: () => ipcRenderer.invoke('db-ready'),
  // ⚙ 設定
  settingsGet: () => ipcRenderer.invoke('settings-get'),
  settingsSetMaxMinutes: (v) => ipcRenderer.invoke('settings-set-max-minutes', v),
  // セトリ候補の保存と呼び出し
  setlistSave: (arg) => ipcRenderer.invoke('setlist-save', arg),
  setlistList: () => ipcRenderer.invoke('setlist-list'),
  setlistLoad: (id) => ipcRenderer.invoke('setlist-load', id),
  setlistDelete: (id) => ipcRenderer.invoke('setlist-delete', id),
  /** 読み込みと解析を始める。進捗は onIngest で流れてくる */
  ingest: (xmlPath) => ipcRenderer.invoke('ingest', xmlPath),
  /** 途中でやめる */
  ingestCancel: () => ipcRenderer.invoke('ingest-cancel'),
  /** 進捗の受け口。{phase, done, total, line} が流れてくる */
  onIngest: (cb) => ipcRenderer.on('ingest', (_e, msg) => cb(msg)),
});
