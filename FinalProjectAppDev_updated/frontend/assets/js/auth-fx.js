// Small UI helpers for login/register pages (no effect on app logic).
(function () {
  // split headline into animated words
  var h = document.querySelector('.auth-visual h2');
  if (h) {
    h.innerHTML = h.textContent.trim().split(/\s+/).map(function (w, i) {
      return '<span class="w" style="animation-delay:' + (0.1 + i * 0.09) + 's">' + w + '</span>';
    }).join(' ');
  }

  // password show/hide
  var eye = '<svg class="on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>' +
    '<svg class="off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.9 10.9 0 0112 20C5 20 1 12 1 12a18 18 0 015.1-5.9M9.9 4.2A10.9 10.9 0 0112 4c7 0 11 8 11 8a18 18 0 01-2.2 3.2M1 1l22 22"/></svg>';
  document.querySelectorAll('input[type="password"]').forEach(function (inp) {
    var wrap = document.createElement('div'); wrap.className = 'pw-wrap';
    inp.parentNode.insertBefore(wrap, inp); wrap.appendChild(inp);
    var b = document.createElement('button'); b.type = 'button'; b.className = 'pw-toggle';
    b.setAttribute('aria-label', 'Show password'); b.innerHTML = eye;
    b.addEventListener('click', function () {
      var show = inp.type === 'password'; inp.type = show ? 'text' : 'password';
      b.classList.toggle('on', show); b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    wrap.appendChild(b);
  });

  // loading state on submit; cleared on error / step change / timeout
  document.querySelectorAll('form').forEach(function (f) {
    f.addEventListener('submit', function () {
      var btn = f.querySelector('button[type="submit"]'); if (!btn) return;
      btn.classList.add('loading');
      setTimeout(function () { btn.classList.remove('loading'); }, 6000);
    });
  });
  var clear = function () { document.querySelectorAll('.btn.loading').forEach(function (b) { b.classList.remove('loading'); }); };
  new MutationObserver(function (m) {
    m.forEach(function (r) {
      var t = r.target;
      if (t.classList.contains('error-text') && t.classList.contains('show')) clear();
      if (/^step/.test(t.id || '')) clear();
    });
  }).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });

  // OTP: backspace goes back, paste fills all boxes
  var otp = [].slice.call(document.querySelectorAll('.otp-row input'));
  otp.forEach(function (inp, i) {
    inp.setAttribute('inputmode', 'numeric'); inp.setAttribute('autocomplete', 'one-time-code');
    inp.addEventListener('keydown', function (e) { if (e.key === 'Backspace' && !inp.value && otp[i - 1]) otp[i - 1].focus(); });
    inp.addEventListener('paste', function (e) {
      var d = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, otp.length); if (!d) return;
      e.preventDefault();
      d.split('').forEach(function (c, k) { otp[k].value = c; otp[k].classList.add('filled'); });
      otp[Math.min(d.length, otp.length - 1)].focus();
    });
  });
})();
