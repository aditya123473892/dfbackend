import * as path from 'path';

const Module = require('module');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (
  request: string,
  parent: NodeModule,
  isMain: boolean,
  options?: any,
) {
  if (request.startsWith('src/')) {
    const relativeRequest = request.slice('src/'.length);
    const distRequest = path.join(__dirname, relativeRequest);

    return originalResolveFilename.call(
      this,
      distRequest,
      parent,
      isMain,
      options,
    );
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};
