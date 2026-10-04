export async function api(path, options = {}) {
  const hasBody = options.body !== undefined;
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(hasBody && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(hasBody ? { body: isFormData ? options.body : JSON.stringify(options.body) } : {}),
  });

  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `A solicitação falhou (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
