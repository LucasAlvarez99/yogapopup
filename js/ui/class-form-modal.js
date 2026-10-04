import { canonicalCategory, CATEGORY_HINT_CLASS, categoryProblem, cleanCategory, parseSortOrder, SORT_HINT } from '../lib/catalog-fields.js';
import { el, mount } from '../lib/dom.js';
import { LEVEL_LABELS } from '../lib/format.js';
import { AppError, messageFor } from '../lib/errors.js';
import { assertVideoReady, sanitizeDuration, videoFileProblem } from '../lib/video-upload.js';
import { adminCreateUpload, adminSyncVideo, adminUpdateClass, deleteThumbnailByUrl, readVideoDuration, resizeImage, uploadThumbnail, uploadVideoToR2 } from '../lib/api.js';
import { toast } from './toast.js';
import * as session from '../lib/session.js';

/**
 * Fases 8-11 (panel administrativo): crear una clase y subir su video (con barra de progreso),
 * reintentar la subida de una clase existente cuyo video quedó pendiente/incompleto/con error,
 * o editar los metadatos de una clase ya creada sin tocar su video (Fase 9).
 *
 * El video SIEMPRE se sube directo del navegador a R2 (PUT prefirmado): el archivo nunca pasa
 * por nuestro backend. `admin-create-upload` solo prepara la URL firmada.
 */
let modalEl, bsModal, bodyEl, titleEl;
const ACCESS_LABELS = { free: 'Gratis', restricted: 'Contenido restringido' };

function build() {
  titleEl = el('h2', { class: 'modal-title', id: 'classFormTitle' });
  bodyEl = el('div', { class: 'modal-body' });
  modalEl = el('div', { class: 'modal fade', id: 'classFormModal', tabindex: -1, 'aria-labelledby': 'classFormTitle', 'aria-hidden': 'true' },
    el('div', { class: 'modal-dialog modal-dialog-centered' },
      el('div', { class: 'modal-content' },
        el('div', { class: 'modal-header' }, titleEl,
          el('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'modal', 'aria-label': 'Cerrar' })),
        bodyEl)));
  document.body.append(modalEl);
  bsModal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
}

function showError(form, message) {
  let box = form.querySelector('.yp-form-error');
  if (!box) box = form.insertBefore(el('div', { class: 'alert alert-danger yp-form-error', role: 'alert' }), form.firstChild);
  box.textContent = message;
}

function field(id, label, node, hint) {
  return el('div', { class: 'mb-3' }, el('label', { class: 'form-label', for: id }, label), node,
    hint ? el('div', { class: 'form-text' }, hint) : null);
}

function levelSelect(current) {
  return el('select', { class: 'form-select', id: 'cfLevel' },
    ...Object.entries(LEVEL_LABELS).map(([v, label]) => el('option', { value: v, selected: v === current }, label)));
}

function accessSelect(current) {
  return el('select', { class: 'form-select', id: 'cfAccess' },
    ...Object.entries(ACCESS_LABELS).map(([v, label]) => el('option', { value: v, selected: v === current }, label)));
}

/** @returns {object} los campos de la clase, o `{ error }` si Categoría u Orden no son válidos. */
function readMetaFromForm(form, { categories = [], previousCategory = null } = {}) {
  const category = cleanCategory(form.cfCategory.value);
  const categoryError = categoryProblem(category, { previous: previousCategory });
  if (categoryError) return { error: categoryError };
  const sort = parseSortOrder(form.cfSort.value);
  if (sort.error) return { error: sort.error };
  return {
    title: form.cfTitle.value.trim(),
    description: form.cfDescription.value.trim() || null,
    category: canonicalCategory(category, categories) || null,
    level: form.cfLevel.value,
    access_level: form.cfAccess.value,
    sort_order: sort.value,
  };
}

/**
 * @param {{mode: 'create'|'retry'|'edit', row?: object}} opts row es obligatorio en modo 'retry'/'edit'.
 * @returns {Promise<boolean>} true si se guardó/subió/creó algo, aunque la subida del video haya fallado (conviene refrescar la lista).
 */
export function openClassForm({ mode = 'create', row = null, categories = [] } = {}) {
  // Crear una clase o subir/reintentar su video es del developer. El panel ya no ofrece estas acciones al admin;
  // esta guarda evita abrir el formulario por un camino olvidado (el servidor y la base lo rechazan igual).
  if (mode !== 'edit' && !session.canUpload()) {
    toast(messageFor(new AppError('developer_only')), { type: 'error' });
    return Promise.resolve(false);
  }
  if (!modalEl) build();
  titleEl.textContent = mode === 'edit' ? `Editar · ${row.title}` : mode === 'retry' ? `Subir video · ${row.title}` : 'Nueva clase';

  const showVideo = mode !== 'edit'; // en 'edit' se cambian los datos, nunca el video (eso es 'retry')

  const progressWrap = el('div', { class: 'mb-3 d-none' },
    el('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Progreso de la subida' },
      el('div', { class: 'progress-bar bg-brand' })),
    el('p', { class: 'form-text mb-0' }));
  const [progressBox, barBox, progressText] = [progressWrap, progressWrap.querySelector('.progress-bar'), progressWrap.querySelector('.form-text')];

  const metaFields = mode === 'retry'
    ? [el('p', { class: 'text-muted small' }, 'El título y los demás datos de la clase no cambian acá; solo se sube el video.')]
    : [
      field('cfTitle', 'Título', el('input', { class: 'form-control', id: 'cfTitle', required: true, maxlength: 150, value: row?.title ?? '' })),
      field('cfDescription', 'Descripción', el('textarea', { class: 'form-control', id: 'cfDescription', rows: 3, maxlength: 5000 }, row?.description ?? '')),
      el('div', { class: 'row' },
        el('div', { class: 'col-12 col-sm-6' }, field('cfCategory', 'Categoría',
          el('input', { class: 'form-control', id: 'cfCategory', maxlength: 60, list: 'cfCategoryList', autocomplete: 'off', placeholder: 'Vinyasa', value: row?.category ?? '' }),
          CATEGORY_HINT_CLASS),
        // Categorías ya usadas: se sugieren al escribir, para no crear "vinyasa" y "Vinyasa" por separado.
        el('datalist', { id: 'cfCategoryList' }, ...categories.map((c) => el('option', { value: c })))),
        el('div', { class: 'col-12 col-sm-6' }, field('cfSort', 'Orden',
          el('input', { class: 'form-control', id: 'cfSort', type: 'number', inputmode: 'numeric', value: String(row?.sort_order ?? 0), step: '1' }),
          SORT_HINT))),
      el('div', { class: 'row' },
        el('div', { class: 'col-12 col-sm-6' }, field('cfLevel', 'Nivel', levelSelect(row?.level ?? 'todos'))),
        el('div', { class: 'col-12 col-sm-6' }, field('cfAccess', 'Acceso', accessSelect(row?.access_level ?? 'free')))),
      field('cfThumb', mode === 'edit' ? 'Reemplazar miniatura (opcional)' : 'Miniatura (opcional)',
        el('input', { class: 'form-control', id: 'cfThumb', type: 'file', accept: 'image/jpeg,image/png,image/webp' })),
      mode === 'edit' && row?.thumbnail_url ? el('img', { src: row.thumbnail_url, alt: '', class: 'yp-cf-thumb-preview', width: 120 }) : null,
    ];

  const form = el('form', { novalidate: true },
    ...metaFields,
    showVideo ? field('cfVideo', 'Video', el('input', { class: 'form-control', id: 'cfVideo', type: 'file', accept: 'video/*', required: true })) : null,
    showVideo ? progressBox : null,
    el('div', { class: 'd-flex gap-2' },
      el('button', { type: 'submit', class: 'btn btn-brand flex-grow-1' }, mode === 'edit' ? 'Guardar cambios' : mode === 'retry' ? 'Subir video' : 'Crear y subir'),
      showVideo ? el('button', { type: 'button', class: 'btn btn-outline-secondary d-none', id: 'cfCancel' }) : null));
  if (showVideo) form.querySelector('#cfCancel').textContent = 'Cancelar subida';

  const cancelBtn = showVideo ? form.querySelector('#cfCancel') : null;
  let aborter = null, aborted = false;
  // La clase que ya se creó en este formulario. Si la subida falla y se vuelve a intentar, se REANUDA esa clase
  // (misma key en R2) en vez de crear otra: sin esto cada reintento dejaba una clase duplicada sin video.
  let created = null;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type=submit]');

    if (mode === 'edit') {
      const patch = readMetaFromForm(form, { categories, previousCategory: row.category });
      if (patch.error) return showError(form, patch.error);
      if (!patch.title) return showError(form, 'El título es obligatorio.');
      submitBtn.disabled = true;
      try {
        const thumbFile = form.cfThumb.files[0];
        const previousThumb = row.thumbnail_url;
        if (thumbFile) {
          const blob = await resizeImage(thumbFile);
          patch.thumbnail_url = await uploadThumbnail(row.id, blob);
        }
        await adminUpdateClass(row.id, patch);
        // Recién ahora, con el cambio ya guardado: borrar la miniatura vieja (mejor esfuerzo, no bloquea).
        if (thumbFile && previousThumb) deleteThumbnailByUrl(previousThumb).catch(() => {});
        closeModal();
        toast('Cambios guardados.', { type: 'success' });
        resolveOpen(true);
      } catch (err) {
        submitBtn.disabled = false;
        showError(form, messageFor(err));
      }
      return;
    }

    const videoFile = form.cfVideo.files[0];
    const fileProblem = videoFileProblem(videoFile);
    if (fileProblem) return showError(form, fileProblem);
    const title = mode === 'retry' ? row.title : form.cfTitle.value.trim();
    if (mode !== 'retry' && !title) return showError(form, 'El título es obligatorio.');
    // Categoría y Orden se validan ANTES de crear nada (un error aquí no debe dejar una clase a medias).
    const meta = mode === 'retry' ? null : readMetaFromForm(form, { categories });
    if (meta?.error) return showError(form, meta.error);

    submitBtn.disabled = true;
    aborted = false;
    try {
      const payload = mode === 'retry'
        ? { class_id: row.id, title: row.title, description: row.description, category: row.category, level: row.level, access_level: row.access_level, sort_order: row.sort_order }
        : { ...(created ? { class_id: created.id } : {}), title, ...meta };
      progressText.textContent = mode === 'retry' ? 'Preparando la subida…' : 'Creando la clase…';
      progressBox.classList.remove('d-none');
      const firstAttempt = mode === 'create' && !created;
      const { class: cls, upload } = await adminCreateUpload(payload);
      if (mode === 'create') created = cls;

      const thumbFile = firstAttempt ? form.cfThumb.files[0] : null; // la miniatura se sube una sola vez
      if (thumbFile) {
        try {
          const blob = await resizeImage(thumbFile);
          const url = await uploadThumbnail(cls.id, blob);
          await adminUpdateClass(cls.id, { thumbnail_url: url });
        } catch (err) {
          toast(`La clase se creó, pero la miniatura falló: ${messageFor(err)}`, { type: 'error', ms: 6000 });
        }
      }

      // R2 no calcula la duración (no transcodifica): se lee en el navegador antes de subir.
      let duration = null;
      try { duration = sanitizeDuration(await readVideoDuration(videoFile)); } catch { /* se guarda sin duración; se puede corregir después */ }

      cancelBtn.classList.remove('d-none');
      cancelBtn.onclick = () => { aborted = true; aborter?.(); };
      const { promise, abort } = uploadVideoToR2(videoFile, upload, {
        onProgress: (sent, total) => {
          const pct = total ? Math.round((sent / total) * 100) : 0;
          barBox.style.width = `${pct}%`;
          progressText.textContent = `Subiendo el video… ${pct}%`;
        },
      });
      aborter = abort;
      await promise;

      progressText.textContent = 'Confirmando la subida…';
      const { class: synced } = await adminSyncVideo(cls.id, duration);
      assertVideoReady(synced); // 'failed' o sin confirmar = error visible (el modal sigue abierto para reintentar)

      closeModal();
      toast(mode === 'retry' ? 'Video subido.' : 'Clase creada y video subido.', { type: 'success' });
      resolveOpen(true);
    } catch (err) {
      progressBox.classList.add('d-none');
      cancelBtn?.classList.add('d-none');
      submitBtn.disabled = false;
      if (aborted) toast('Subida cancelada.', { ms: 3000 });
      else showError(form, messageFor(err));
    }
  });

  mount(bodyEl, form);
  bsModal.show();
  let resolveOpen;
  return new Promise((resolve) => {
    resolveOpen = resolve;
    const onHidden = () => { modalEl.removeEventListener('hidden.bs.modal', onHidden); resolve(created !== null); };
    modalEl.addEventListener('hidden.bs.modal', onHidden);
  });
}

function closeModal() {
  bsModal.hide();
}
