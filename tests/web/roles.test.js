import assert from "node:assert/strict";
import { canUploadRole, isDeveloperRole, isProfesorRole, isStaffRole, ROLE_LABELS, ROLES } from "../../js/lib/roles.js";

Deno.test("roles: cuatro escalas — user · profesor · admin · developer", () => {
  assert.deepEqual(ROLES, ["user", "profesor", "admin", "developer"]);
  assert.deepEqual(Object.keys(ROLE_LABELS), ROLES);
});

Deno.test("roles: matriz de la interfaz (gestión = admin y developer · subir = solo developer)", () => {
  const expected = {
    //            staff  developer  upload
    user: [false, false, false],
    profesor: [false, false, false], // enseña, pero NO es gestión: sin productos ni videos
    admin: [true, false, false], // gestiona, pero NO sube
    developer: [true, true, true],
  };
  for (const [role, [staff, dev, upload]] of Object.entries(expected)) {
    assert.equal(isStaffRole(role), staff, `${role}: gestión`);
    assert.equal(isDeveloperRole(role), dev, `${role}: developer`);
    assert.equal(canUploadRole(role), upload, `${role}: subir`);
  }
});

Deno.test("roles: lo desconocido NO recibe privilegios (cierra en falso), incluido el antiguo 'owner'", () => {
  for (const bad of ["owner", "superadmin", "ADMIN", "Developer", "", null, undefined, 1, true, {}, []]) {
    assert.equal(isStaffRole(bad), false, `staff ${JSON.stringify(bad)}`);
    assert.equal(isDeveloperRole(bad), false, `developer ${JSON.stringify(bad)}`);
    assert.equal(canUploadRole(bad), false, `subir ${JSON.stringify(bad)}`);
  }
});

Deno.test("roles: profesor solo por su rol; 'sub_admin' (nombre descartado) no existe y no da privilegios", () => {
  assert.equal(isProfesorRole("profesor"), true);
  for (const other of ["user", "admin", "developer", "sub_admin", "Profesor", "", null, undefined]) {
    assert.equal(isProfesorRole(other), false, `profesor ${JSON.stringify(other)}`);
  }
  assert.equal(ROLES.includes("sub_admin"), false);
  assert.equal(isStaffRole("sub_admin"), false);
});

Deno.test("roles: el admin nunca puede subir aunque sea personal de gestión", () => {
  assert.equal(isStaffRole("admin"), true);
  assert.equal(canUploadRole("admin"), false);
});
