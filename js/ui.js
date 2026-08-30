// ui.js wires the global, route-independent UI: the FAB and the two
// hidden file inputs (camera/library) shared across the Add and Edit Entry
// flows. The actual views live in js/views/*.js; shared primitives live in
// js/ui-core.js. Must load after both, since it calls FatterUI.startAddEntryFlow
// and FatterUI.handlePickedFile, which entry-form.js defines.

(function (global) {
  'use strict';

  function initGlobalHandlers() {
    document.getElementById('fab-add').addEventListener('click', () => FatterUI.startAddEntryFlow());
    document.getElementById('photo-input-camera').addEventListener('change', (e) => {
      const file = e.target.files[0]; e.target.value = '';
      FatterUI.handlePickedFile(file);
    });
    document.getElementById('photo-input-library').addEventListener('change', (e) => {
      // Edit Entry's "Change photo" reuses this same hidden input and sets a
      // handler here to intercept the pick instead of going through the
      // normal Add-Entry path (see js/views/entry-form.js's openEditEntry).
      if (global.__fatterEditPhotoHandler) { global.__fatterEditPhotoHandler(e); return; }
      const file = e.target.files[0]; e.target.value = '';
      FatterUI.handlePickedFile(file);
    });
  }

  global.FatterUI = global.FatterUI || {};
  global.FatterUI.initGlobalHandlers = initGlobalHandlers;
})(window);
