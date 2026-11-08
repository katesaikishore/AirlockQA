(() => {
  const form = document.getElementById('pro-waitlist-form');
  const status = document.getElementById('waitlist-status');
  if (!form || !status) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = (form.email.value || '').trim();
    const useCase = (form.useCase.value || '').trim();
    if (!email || !form.email.checkValidity()) {
      status.textContent = 'Enter a valid email address.';
      form.email.focus();
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = 'Joining…';
    try {
      const response = await fetch('/api/v1/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, useCase, source: 'pricing' }),
      });
      if (response.status === 201 || response.status === 200) {
        status.textContent = 'You are on the waitlist. We will ask what you need before publishing pricing.';
        form.reset();
      } else if (response.status === 429) {
        status.textContent = 'Too many requests from this address. Try again later.';
      } else {
        status.textContent = 'Could not join the waitlist right now. Please try again.';
      }
    } catch {
      status.textContent = 'Could not reach AirlockQA. Check your connection and try again.';
    } finally {
      button.disabled = false;
    }
  });
})();
