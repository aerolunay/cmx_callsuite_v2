// All the optional lead fields, shown only when actually present on
// the lead — no point rendering a wall of empty "—" rows.
const FIELD_LABELS = [
  ["address1", "Address 1"],
  ["address2", "Address 2"],
  ["address3", "Address 3"],
  ["city", "City"],
  ["state", "State"],
  ["province", "Province"],
  ["postal_code", "Postal Code"],
  ["country_code", "Country"],
  ["gender", "Gender"],
  ["date_of_birth", "Date of Birth"],
  ["alt_phone", "Alt Phone"],
  ["email", "Email"],
];

export default function ContactDetailsCard({ lead }) {
  return (
    <div className="card contact-card">
      <h3>Contact Details</h3>
      <p className="lead-name">
        {lead.first_name} {lead.last_name}
      </p>
      <p className="lead-phone">{lead.phone_number}</p>

      <dl className="contact-fields">
        {FIELD_LABELS.filter(([key]) => lead[key]).map(([key, label]) => (
          <div className="contact-field-row" key={key}>
            <dt>{label}</dt>
            <dd>{lead[key]}</dd>
          </div>
        ))}
      </dl>

      {lead.comments && (
        <div className="lead-notes">
          <strong>Notes</strong>
          <p>{lead.comments}</p>
        </div>
      )}
    </div>
  );
}
