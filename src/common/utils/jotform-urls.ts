const base = `https://api.jotform.com`;

export default {
  allForms: (apiKey: string) => base + `/user/forms?apiKey=${apiKey}`,
  user: (apiKey: string) => base + `/user?apiKey=${apiKey}`,
};
