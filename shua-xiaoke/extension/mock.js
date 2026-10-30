'use strict';
/**
 * 刷小课 · 自检页脚本
 * 仅在本地后端提供的 /mock/* 页面上运行,用来验证「识别题目 → 解题 → 写回页面」整条链路。
 * 真实站点上不注入,不影响正常刷课。
 */
(async () => {
  await SXK.loadSettings();
  SXK.log('selftest', 'loaded');
  SXK.listenAutoAnswer('selftest');
  if (SXK.startSettingsSync) SXK.startSettingsSync();
  if (SXK.watchAutoAnswer) SXK.watchAutoAnswer('selftest');
})();
