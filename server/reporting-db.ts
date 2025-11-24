import postgres from 'postgres';

if (!process.env.REPORTING_DATABASE_URL) {
  throw new Error(
    "REPORTING_DATABASE_URL must be set. Did you forget to add the reporting database secret?",
  );
}

export const reportingSql = postgres(process.env.REPORTING_DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export async function testReportingConnection() {
  try {
    const result = await reportingSql`SELECT current_database(), current_user, version()`;
    console.log('✓ Reporting database connected:', result[0]);
    return true;
  } catch (error) {
    console.error('Failed to connect to reporting database:', error);
    throw error;
  }
}
